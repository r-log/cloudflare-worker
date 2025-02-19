import { JobStatus, QueueManager, JobResult } from './types';
import { logger } from './logger';
import { v4 as uuidv4 } from 'uuid';
import { fetchPRFiles, fetchFileContent, findMarkdownFiles, PullRequestFile } from './utils';
import { ArticleValidator } from './articleValidator';

// In-memory storage
let queueState: QueueManager = { queue: [] };
const LOCK_TIMEOUT = 60000; // 1 minute
let lockTimestamp: number | null = null;

export class ArticleCheckQueue {
  private isLocked(): boolean {
    if (!lockTimestamp) return false;
    const now = Date.now();
    if (now - lockTimestamp > LOCK_TIMEOUT) {
      lockTimestamp = null;
      return false;
    }
    return true;
  }

  private acquireLock(): boolean {
    if (this.isLocked()) {
      logger.warn('Failed to acquire queue lock, another process may be updating the queue');
      return false;
    }
    lockTimestamp = Date.now();
    return true;
  }

  private releaseLock(): void {
    lockTimestamp = null;
    logger.debug('Released queue lock');
  }

  private getQueue(): QueueManager {
    logger.debug('Retrieved queue state', { 
      currentJob: queueState.currentJob?.id, 
      queueLength: queueState.queue.length 
    });
    return queueState;
  }

  private saveQueue(manager: QueueManager): void {
    queueState = manager;
    logger.debug('Saved queue state', { 
      currentJob: manager.currentJob?.id, 
      queueLength: manager.queue.length 
    });
  }

  async addJob(prNumber: number, repoFullName: string): Promise<JobStatus> {
    if (!this.acquireLock()) {
      logger.error('Failed to acquire lock for adding job', { prNumber, repoFullName });
      throw new Error('Failed to acquire lock');
    }

    try {
      const manager = this.getQueue();
      const newJob: JobStatus = {
        id: uuidv4(),
        status: 'queued',
        prNumber,
        repoFullName,
        queuePosition: manager.queue.length,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      if (!manager.currentJob) {
        manager.currentJob = { ...newJob, status: 'processing', queuePosition: 0 };
        logger.info('Starting new job immediately', { jobId: newJob.id, prNumber, repoFullName });
      } else {
        manager.queue.push(newJob);
        logger.info('Added job to queue', { 
          jobId: newJob.id, 
          prNumber, 
          repoFullName, 
          queuePosition: newJob.queuePosition 
        });
      }

      this.saveQueue(manager);
      return manager.currentJob.id === newJob.id ? manager.currentJob : newJob;
    } finally {
      this.releaseLock();
    }
  }

  async completeJob(jobId: string, result: JobResult): Promise<void> {
    if (!this.acquireLock()) {
      logger.error('Failed to acquire lock for completing job', { jobId });
      throw new Error('Failed to acquire lock');
    }

    try {
      const manager = this.getQueue();
      if (!manager.currentJob || manager.currentJob.id !== jobId) {
        logger.error('Job not found or not currently processing', { 
          jobId,
          currentJobId: manager.currentJob?.id 
        });
        throw new Error('Job not found or not currently processing');
      }

      manager.currentJob.status = result.status === 'success' ? 'completed' : 'failed';
      manager.currentJob.result = result.message;
      manager.currentJob.updatedAt = new Date().toISOString();

      logger.info('Completed job', { 
        jobId,
        status: manager.currentJob.status,
        prNumber: manager.currentJob.prNumber
      });

      // Process next job in queue if any
      if (manager.queue.length > 0) {
        const nextJob = manager.queue.shift()!;
        manager.currentJob = {
          ...nextJob,
          status: 'processing',
          queuePosition: 0,
          updatedAt: new Date().toISOString()
        };

        logger.info('Starting next job from queue', { 
          jobId: manager.currentJob.id,
          prNumber: manager.currentJob.prNumber,
          remainingQueueLength: manager.queue.length
        });

        // Update queue positions
        manager.queue.forEach((job, index) => {
          job.queuePosition = index;
        });
      } else {
        delete manager.currentJob;
        logger.info('No more jobs in queue');
      }

      this.saveQueue(manager);
    } finally {
      this.releaseLock();
    }
  }

  async getCurrentStatus(): Promise<QueueManager> {
    const status = this.getQueue();
    logger.debug('Retrieved current queue status', {
      hasCurrentJob: !!status.currentJob,
      queueLength: status.queue.length
    });
    return status;
  }
}

export async function performArticleCheck(
  prNumber: number,
  repoFullName: string,
  githubToken: string,
  openRouterApiKey: string,
  claudeApiKey: string,
  braveApiKey: string
): Promise<JobResult> {
  logger.info('Starting article check', { prNumber, repoFullName });

  try {
    // Fetch PR files
    const files = await fetchPRFiles(repoFullName, prNumber, githubToken);
    const markdownFiles = findMarkdownFiles(files);

    if (markdownFiles.length === 0) {
      return {
        status: 'failure',
        message: 'No markdown files found in this PR. Please make sure you have added or modified a .md file.',
        details: {
          files: files.map(f => f.filename)
        }
      };
    }

    if (markdownFiles.length > 1) {
      return {
        status: 'failure',
        message: 'Multiple markdown files found in this PR. Please submit only one article at a time.',
        details: {
          files: markdownFiles.map(f => f.filename)
        }
      };
    }

    const mdFile = markdownFiles[0];
    const content = await fetchFileContent(mdFile.raw_url, githubToken);
    
    // Validate article structure with duplication check and fact checking
    const validator = new ArticleValidator(githubToken, repoFullName, claudeApiKey, braveApiKey);
    const validationResult = await validator.validateArticle(content, mdFile.filename, openRouterApiKey);

    if (!validationResult.isValid) {
      let message = '### Article Validation Failed\n\n';

      if (validationResult.duplicationCheck?.isDuplicate) {
        message = '### Article Validation Failed\n\n' +
          '#### Duplication Check Results:\n' +
          `This article appears to be a duplicate of: ${validationResult.duplicationCheck.existingFilePath}\n\n` +
          '**Similarity Analysis:**\n';
        
        if (validationResult.duplicationCheck.comparisonResult?.similarityScore !== undefined) {
          message += `- Similarity Score: ${(validationResult.duplicationCheck.comparisonResult.similarityScore * 100).toFixed(2)}%\n`;
        }
        return {
          status: 'failure',
          message,
          details: validationResult
        };
      }

      // Only show these validation messages if it's not a duplicate
      if (!validationResult.frontMatterValid) {
        message += '#### Front Matter Issues:\n' + 
          validationResult.errors.filter(err => !err.includes('duplicate')).map(err => `- ${err}`).join('\n') +
          '\n\n';
      }
      
      if (!validationResult.sectionsValid) {
        if (validationResult.missingRequiredSections.length > 0) {
          message += '#### Missing Required Sections:\n' +
            validationResult.missingRequiredSections.map(section => `- ${section}`).join('\n') +
            '\n\n';
        }
        if (validationResult.additionalSections.length > 0) {
          message += '#### Additional Unexpected Sections:\n' +
            validationResult.additionalSections.map(section => `- ${section}`).join('\n') +
            '\n\n';
        }
      }

      // Add fact-checking results if available
      if (validationResult.factCheck) {
        message += '#### Fact-Checking Results:\n';
        
        if (validationResult.factCheck.verifiedFacts.length > 0) {
          message += '\n**Verified Facts:**\n' +
            validationResult.factCheck.verifiedFacts
              .map(fact => `- ${fact.statement} (Confidence: ${(fact.confidence * 100).toFixed(1)}%)\n  Sources: ${fact.sources.map(s => s.url).join(', ')}`).join('\n') +
            '\n\n';
        }

        if (validationResult.factCheck.unreliableFacts.length > 0) {
          message += '**Unreliable Facts:**\n' +
            validationResult.factCheck.unreliableFacts
              .map(fact => `- ${fact.statement}\n  Reason: ${fact.reason}${fact.suggestedCorrection ? `\n  Suggested Correction: ${fact.suggestedCorrection}` : ''}`).join('\n') +
            '\n\n';
        }

        message += `**Overall Fact-Check Confidence:** ${(validationResult.factCheck.confidence * 100).toFixed(1)}%\n\n`;
      }

      if (validationResult.warnings.length > 0) {
        message += '#### Warnings:\n' +
          validationResult.warnings.map(warn => `- ${warn}`).join('\n') +
          '\n\n';
      }

      message += '#### Required Article Structure:\n' +
        '1. Front matter with:\n' +
        '   - date (YYYY-MM-DD)\n' +
        '   - target-entities\n' +
        '   - entity-types (array)\n' +
        '   - attack-types\n' +
        '   - title\n' +
        '   - loss (number)\n\n' +
        '2. Required sections:\n' +
        '   - Summary\n' +
        '   - Attackers\n' +
        '   - Losses\n' +
        '   - Timeline\n' +
        '   - Security Failure Causes';

      return {
        status: 'failure',
        message,
        details: validationResult
      };
    }

    let successMessage = '### Article Validation Successful! 🎉\n\n';
    
    if (validationResult.duplicationCheck?.comparisonResult?.hasNewInformation) {
      successMessage += '#### New Information Detected\n' +
        'While a similar article exists, this submission contains valuable new information:\n\n' +
        validationResult.duplicationCheck.comparisonResult.differences?.map(diff => `- ${diff}`).join('\n') +
        '\n\n';
    }

    // Add fact-checking success details
    if (validationResult.factCheck) {
      successMessage += '#### Fact-Checking Results\n' +
        `Successfully verified ${validationResult.factCheck.verifiedFacts.length} facts with ${validationResult.factCheck.sourcesUsed.length} reliable sources.\n\n` +
        '**Key Verified Facts:**\n' +
        validationResult.factCheck.verifiedFacts
          .filter(fact => fact.confidence > 0.8)
          .map(fact => `- ${fact.statement} (${(fact.confidence * 100).toFixed(1)}% confidence)`).join('\n') +
        '\n\n' +
        `**Overall Fact-Check Confidence:** ${(validationResult.factCheck.confidence * 100).toFixed(1)}%\n\n`;
    }

    successMessage += '#### Validated Components:\n' +
      '- ✅ Front matter format and required fields\n' +
      '- ✅ All required sections present\n' +
      '- ✅ Section content validation\n' +
      '- ✅ Duplication check\n' +
      (validationResult.factCheck ? '- ✅ Fact verification\n' : '') +
      '\n' +
      'The article is ready for review!';

    return {
      status: 'success',
      message: successMessage,
      details: {
        validationResult,
        filename: mdFile.filename
      }
    };
  } catch (error) {
    logger.error('Error during article check:', error);
    return {
      status: 'failure',
      message: 'An error occurred while checking the article: ' + 
        (error instanceof Error ? error.message : 'Unknown error'),
      details: {
        error: error instanceof Error ? error.message : 'Unknown error'
      }
    };
  }
} 