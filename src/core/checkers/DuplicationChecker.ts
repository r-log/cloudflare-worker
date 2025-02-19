import { BaseValidator } from '../validators/BaseValidator';
import { DuplicationCheckResult, ComparisonResult } from '../types';
import { logger } from '../logger';

interface OpenRouterResponse {
  choices: Array<{
    message: {
      content: string;
    };
  }>;
}

export class DuplicationChecker extends BaseValidator {
  private async compareWithOpenRouter(newContent: string, existingContent: string, apiKey: string): Promise<ComparisonResult> {
    try {
      logger.info('Starting OpenRouter GPT-3.5 comparison', {
        newContentLength: newContent.length,
        existingContentLength: existingContent.length
      });

      const requestBody = {
        model: 'openai/gpt-3.5-turbo',
        messages: [
          {
            role: 'system',
            content: 'You are an expert at comparing articles and identifying new information. You must respond with raw JSON only, no markdown formatting or explanation text.'
          },
          {
            role: 'user',
            content: `Compare these two articles and determine if the new article contains any significant new information not present in the existing article. Respond with raw JSON only (no markdown, no code blocks) using this exact format:
{"hasNewInformation": boolean, "differences": string[], "similarityScore": number}

Existing article:
${existingContent}

New article:
${newContent}`
          }
        ]
      };

      logger.debug('Sending request to OpenRouter', { requestBody });

      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://github.com/r-log/cloudflare-worker',
        },
        body: JSON.stringify(requestBody)
      });

      if (!response.ok) {
        const errorText = await response.text();
        logger.error('OpenRouter API error:', {
          status: response.status,
          statusText: response.statusText,
          error: errorText
        });
        throw new Error(`OpenRouter API error: ${response.status} ${response.statusText} - ${errorText}`);
      }

      const data = await response.json() as OpenRouterResponse;
      const rawResponse = data.choices[0].message.content;
      logger.debug('Received response from OpenRouter', { rawResponse });

      try {
        // Clean the response - remove any potential markdown formatting
        const cleanedResponse = rawResponse.replace(/```[a-z]*\n?|\n```/g, '').trim();
        logger.debug('Cleaned response:', { cleanedResponse });
        
        const result = JSON.parse(cleanedResponse);
        
        // Validate the parsed result has the expected structure
        if (typeof result.hasNewInformation !== 'boolean' || 
            !Array.isArray(result.differences) || 
            typeof result.similarityScore !== 'number') {
          throw new Error('Invalid response format from OpenRouter');
        }

        logger.info('Parsed comparison result', {
          hasNewInformation: result.hasNewInformation,
          similarityScore: result.similarityScore,
          differences: result.differences
        });

        return {
          hasNewInformation: result.hasNewInformation,
          differences: result.differences,
          similarityScore: result.similarityScore
        };
      } catch (parseError) {
        logger.error('Failed to parse OpenRouter response:', {
          error: parseError,
          rawResponse,
          cleanedResponse: rawResponse.replace(/```[a-z]*\n?|\n```/g, '').trim()
        });
        throw new Error(`Failed to parse OpenRouter response: ${parseError instanceof Error ? parseError.message : 'Unknown error'}`);
      }
    } catch (error) {
      logger.error('Error comparing articles with OpenRouter:', error);
      throw error;
    }
  }

  private async findExistingArticles(filename: string): Promise<string[]> {
    try {
      const path = 'content/research/cyberattacks/incidents';
      // Extract just the base filename without any directory prefix
      const baseFilename = filename.split('/').pop() || filename;
      logger.info('Searching for existing articles:', { path, filename, baseFilename });

      const response = await fetch(
        `https://api.github.com/repos/${this.repoOwner}/${this.repoName}/contents/${path}`,
        {
          headers: {
            'Authorization': `Bearer ${this.githubToken}`,
            'Accept': 'application/vnd.github.v3+json',
            'User-Agent': 'ArticleChecker-Bot'
          }
        }
      );

      if (!response.ok) {
        const errorText = await response.text();
        logger.error('GitHub API error in findExistingArticles:', { 
          status: response.status, 
          statusText: response.statusText,
          error: errorText,
          path,
          filename: baseFilename
        });
        throw new Error(`GitHub API error: ${response.status} ${response.statusText} - ${errorText}`);
      }

      const files = await response.json() as Array<{ name: string, path: string }>;
      logger.info('Found files in directory:', { 
        totalFiles: files.length,
        allFiles: files.map(f => f.name).join(', ')
      });

      const matchingFiles = files.filter(file => file.name === baseFilename);
      logger.info('Matching files found:', { 
        filename: baseFilename,
        matchCount: matchingFiles.length,
        matches: matchingFiles.map(f => f.path)
      });

      return matchingFiles.map(file => file.path);
    } catch (error) {
      logger.error('Error finding existing articles:', error);
      throw error;
    }
  }

  public async checkDuplication(newContent: string, filename: string, openRouterApiKey: string): Promise<DuplicationCheckResult> {
    try {
      logger.info('Starting duplication check:', { filename });

      const existingFiles = await this.findExistingArticles(filename);
      logger.info('Found existing files:', { 
        filename,
        existingFilesCount: existingFiles.length,
        existingFiles
      });

      if (existingFiles.length === 0) {
        logger.info('No existing files found, article is not a duplicate');
        return { isDuplicate: false };
      }

      // Compare with each existing file
      for (const existingFile of existingFiles) {
        logger.info('Comparing with existing file:', { existingFile });
        
        const existingContent = await this.fetchFileContent(existingFile);
        const comparisonResult = await this.compareWithOpenRouter(newContent, existingContent, openRouterApiKey);
        
        logger.info('Comparison result:', { 
          existingFile,
          hasNewInformation: comparisonResult.hasNewInformation,
          similarityScore: comparisonResult.similarityScore,
          differences: comparisonResult.differences
        });

        // If similarity is high and no new information, it's a duplicate
        if (!comparisonResult.hasNewInformation && comparisonResult.similarityScore && comparisonResult.similarityScore > 0.8) {
          logger.info('Article identified as duplicate:', {
            existingFile,
            similarityScore: comparisonResult.similarityScore
          });
          return {
            isDuplicate: true,
            existingFilePath: existingFile,
            comparisonResult
          };
        }

        // If we found a similar article but it has new information
        if (comparisonResult.hasNewInformation) {
          logger.info('Article contains new information:', {
            existingFile,
            differences: comparisonResult.differences
          });
          return {
            isDuplicate: false,
            existingFilePath: existingFile,
            comparisonResult
          };
        }
      }

      logger.info('No duplicates found after checking all existing files');
      return { isDuplicate: false };
    } catch (error) {
      logger.error('Error checking for duplicates:', error);
      throw error;
    }
  }
} 