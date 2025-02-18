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

export async function mockArticleCheck(
  prNumber: number,
  repoFullName: string,
  githubToken: string
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
    
    // Validate article structure
    const validator = new ArticleValidator();
    const validationResult = validator.validateArticle(content);

    if (!validationResult.isValid) {
      const errorMessages = validationResult.errors.map(err => `- ${err}`).join('\n');
      const warningMessages = validationResult.warnings.map(warn => `- ${warn}`).join('\n');
      const missingSection = validationResult.missingRequiredSections.map(section => `- ${section}`).join('\n');
      const additionalSection = validationResult.additionalSections.map(section => `- ${section}`).join('\n');

      let message = '### Article Structure Validation Failed\n\n';
      
      if (!validationResult.frontMatterValid) {
        message += '#### Front Matter Issues:\n' + errorMessages + '\n\n';
      }
      
      if (!validationResult.sectionsValid) {
        if (validationResult.missingRequiredSections.length > 0) {
          message += '#### Missing Required Sections:\n' + missingSection + '\n\n';
        }
        if (validationResult.additionalSections.length > 0) {
          message += '#### Additional Unexpected Sections:\n' + additionalSection + '\n\n';
        }
      }

      if (warningMessages) {
        message += '#### Warnings:\n' + warningMessages + '\n\n';
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

    return {
      status: 'success',
      message: '### Article Structure Validation Successful! 🎉\n\n' +
        'Your article follows all the required structure guidelines. Great job!\n\n' +
        '#### Validated Components:\n' +
        '- ✅ Front matter format and required fields\n' +
        '- ✅ All required sections present\n' +
        '- ✅ Section content validation\n\n' +
        'The article is ready for review!',
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