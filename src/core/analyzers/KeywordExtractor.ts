import { KeywordExtractionResult } from '../types';
import { logger } from '../logger';

interface ClaudeResponse {
  content: [{
    text: string;
  }];
  model: string;
  role: string;
}

export class KeywordExtractor {
  private claudeApiKey: string;
  private lastRequestTime: number = 0;
  private requestsThisMinute: number = 0;
  private inputTokensThisMinute: number = 0;
  private outputTokensThisMinute: number = 0;
  private lastMinuteReset: number = Date.now();

  // Rate limits for Claude 3.5 Sonnet
  private static readonly REQUESTS_PER_MINUTE = 50;
  private static readonly INPUT_TOKENS_PER_MINUTE = 40000;  // Increased from 20000
  private static readonly OUTPUT_TOKENS_PER_MINUTE = 8000;  // Increased from 4000
  private static readonly MIN_REQUEST_INTERVAL = 1200; // 1.2 seconds between requests
  private static readonly MAX_RETRY_TIME = 60000; // Maximum 1 minute of retrying
  private static readonly INITIAL_RETRY_DELAY = 5000; // Start with 5 second delay

  constructor(claudeApiKey: string) {
    this.claudeApiKey = claudeApiKey;
    logger.info('KeywordExtractor initialized');
  }

  private async resetRateLimitsIfNeeded(): Promise<void> {
    const now = Date.now();
    if (now - this.lastMinuteReset >= 60000) {
      this.requestsThisMinute = 0;
      this.inputTokensThisMinute = 0;
      this.outputTokensThisMinute = 0;
      this.lastMinuteReset = now;
      logger.debug('Rate limits reset');
    }
  }

  private async waitForRateLimit(): Promise<void> {
    await this.resetRateLimitsIfNeeded();

    // Ensure minimum interval between requests
    const timeSinceLastRequest = Date.now() - this.lastRequestTime;
    if (timeSinceLastRequest < KeywordExtractor.MIN_REQUEST_INTERVAL) {
      const waitTime = KeywordExtractor.MIN_REQUEST_INTERVAL - timeSinceLastRequest;
      logger.debug(`Waiting ${waitTime}ms for rate limit`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }

    // Wait if we've hit the requests per minute limit
    if (this.requestsThisMinute >= KeywordExtractor.REQUESTS_PER_MINUTE) {
      const waitTime = 60000 - (Date.now() - this.lastMinuteReset);
      logger.warn(`Rate limit reached, waiting ${waitTime}ms`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
      await this.resetRateLimitsIfNeeded();
    }
  }

  // Estimate tokens in a string (rough approximation)
  private estimateTokenCount(text: string): number {
    // Rough estimate: 4 characters per token on average
    return Math.ceil(text.length / 4);
  }

  // Add jitter to prevent thundering herd
  private addJitter(delay: number): number {
    const jitter = delay * 0.1; // 10% jitter
    return delay + (Math.random() * jitter);
  }

  private async callClaudeWithRetry(requestBody: string, maxRetries = 3): Promise<Response> {
    let attempt = 0;
    let lastError: Error | null = null;
    const startTime = Date.now();

    // Estimate input tokens
    const estimatedInputTokens = this.estimateTokenCount(requestBody);
    if (this.inputTokensThisMinute + estimatedInputTokens > KeywordExtractor.INPUT_TOKENS_PER_MINUTE) {
      const waitTime = 60000 - (Date.now() - this.lastMinuteReset);
      logger.warn(`Input token limit reached, waiting ${waitTime}ms`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
      await this.resetRateLimitsIfNeeded();
    }

    while (attempt < maxRetries) {
      try {
        // Check if we've exceeded max retry time
        if (Date.now() - startTime > KeywordExtractor.MAX_RETRY_TIME) {
          logger.error('Exceeded maximum retry time', {
            maxRetryTime: KeywordExtractor.MAX_RETRY_TIME,
            actualTime: Date.now() - startTime
          });
          throw new Error('Exceeded maximum retry time for Claude API');
        }

        await this.waitForRateLimit();

        logger.info('Making Claude API request', {
          attempt: attempt + 1,
          maxRetries,
          timestamp: new Date().toISOString(),
          estimatedInputTokens,
          requestsThisMinute: this.requestsThisMinute,
          inputTokensThisMinute: this.inputTokensThisMinute,
          retryTimeElapsed: Date.now() - startTime
        });

        this.lastRequestTime = Date.now();
        this.requestsThisMinute++;
        this.inputTokensThisMinute += estimatedInputTokens;

        const response = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': this.claudeApiKey,
            'anthropic-version': '2023-06-01'
          },
          body: requestBody
        });

        // If we get an overloaded error, we'll retry
        if (response.status === 529) {
          const errorText = await response.text();
          const baseDelay = KeywordExtractor.INITIAL_RETRY_DELAY * Math.pow(2, attempt);
          const delayWithJitter = this.addJitter(baseDelay);
          
          logger.warn('Claude API overloaded, will retry', {
            attempt: attempt + 1,
            maxRetries,
            baseDelay,
            actualDelay: delayWithJitter,
            errorText,
            timeElapsed: Date.now() - startTime
          });
          
          await new Promise(resolve => setTimeout(resolve, delayWithJitter));
          attempt++;
          continue;
        }

        return response;
      } catch (error) {
        lastError = error as Error;
        logger.error('Error calling Claude API', {
          attempt: attempt + 1,
          error: lastError,
          willRetry: attempt < maxRetries,
          timeElapsed: Date.now() - startTime
        });

        if (attempt < maxRetries) {
          const baseDelay = KeywordExtractor.INITIAL_RETRY_DELAY * Math.pow(2, attempt);
          const delayWithJitter = this.addJitter(baseDelay);
          await new Promise(resolve => setTimeout(resolve, delayWithJitter));
          attempt++;
          continue;
        }
        break;
      }
    }

    throw lastError || new Error('Max retries exceeded calling Claude API');
  }

  private cleanMarkdownJSON(text: string): string {
    // Remove markdown code block syntax and any surrounding whitespace
    return text.replace(/^```json\s*|\s*```$/g, '').trim();
  }

  public async extract(content: string): Promise<KeywordExtractionResult> {
    try {
      // Log content size details
      const contentSizeInBytes = new TextEncoder().encode(content).length;
      logger.info('Content size details:', {
        rawLength: content.length,
        byteSize: contentSizeInBytes,
        sizeInKB: Math.round(contentSizeInBytes / 1024),
        firstLine: content.split('\n')[0]
      });

      // Check if content is too large (Claude's limit is around 100K tokens)
      if (contentSizeInBytes > 150000) { // Approximate byte size for safety
        logger.warn('Content may be too large for Claude API', {
          sizeInKB: Math.round(contentSizeInBytes / 1024),
          recommendation: 'Consider chunking the content'
        });
      }

      const prompt = this.buildPrompt(content);
      
      // Log prompt size details
      const promptSizeInBytes = new TextEncoder().encode(prompt).length;
      logger.info('Prompt size details:', {
        rawLength: prompt.length,
        byteSize: promptSizeInBytes,
        sizeInKB: Math.round(promptSizeInBytes / 1024)
      });

      const requestBody = JSON.stringify({
        model: 'claude-3-sonnet-20240229',  // Changed from opus to sonnet
        max_tokens: 4096,
        messages: [{
          role: 'user',
          content: prompt
        }]
      });

      // Log detailed request size information
      const requestSizeInBytes = new TextEncoder().encode(requestBody).length;
      logger.info('Request size details:', {
        rawLength: requestBody.length,
        byteSize: requestSizeInBytes,
        sizeInKB: Math.round(requestSizeInBytes / 1024),
        messageCount: 1,
        maxTokens: 4096
      });

      try {
        logger.info('Sending request to Claude API...', {
          timestamp: new Date().toISOString(),
          timeoutSet: '25s',
          requestSizeKB: Math.round(requestSizeInBytes / 1024)
        });

        // Log the request details immediately
        logger.info('Claude API Request Details:', {
          timestamp: new Date().toISOString(),
          headers: {
            'Content-Type': 'application/json',
            'anthropic-version': '2023-06-01'
          },
          requestSizeKB: Math.round(requestSizeInBytes / 1024),
          bodyPreview: requestBody.substring(0, 200) + '...'
        });

        // Use the retry mechanism
        const response = await this.callClaudeWithRetry(requestBody);

        // Immediately log response headers
        logger.info('Claude API Response Headers:', {
          timestamp: new Date().toISOString(),
          status: response.status,
          statusText: response.statusText,
          headers: {
            contentType: response.headers.get('content-type'),
            contentLength: response.headers.get('content-length')
          }
        });

        // Start reading the response body immediately
        const responseTextPromise = response.text();

        // Log that we're reading the response
        logger.info('Reading Claude API response...', {
          timestamp: new Date().toISOString()
        });

        if (!response.ok) {
          const errorText = await responseTextPromise;
          logger.error('Claude API Error:', {
            timestamp: new Date().toISOString(),
            status: response.status,
            statusText: response.statusText,
            errorText: errorText
          });
          throw new Error(`Claude API error: ${response.status} ${response.statusText} - ${errorText}`);
        }

        const responseText = await responseTextPromise;
        
        // Log the raw response immediately
        logger.info('Claude API Raw Response:', {
          timestamp: new Date().toISOString(),
          responseLength: responseText.length,
          preview: responseText.substring(0, 200) + '...',
          isJSON: this.isValidJSON(responseText)
        });

        const data = JSON.parse(responseText) as ClaudeResponse;
        const rawContent = data.content[0].text;

        // Clean markdown formatting before parsing JSON
        const cleanedContent = this.cleanMarkdownJSON(rawContent);
        
        logger.debug('Cleaned response content:', {
          originalLength: rawContent.length,
          cleanedLength: cleanedContent.length,
          hasMarkdown: rawContent.includes('```'),
          preview: cleanedContent.substring(0, 200) + '...'
        });

        // Track output tokens
        const estimatedOutputTokens = this.estimateTokenCount(responseText);
        this.outputTokensThisMinute += estimatedOutputTokens;

        if (this.outputTokensThisMinute > KeywordExtractor.OUTPUT_TOKENS_PER_MINUTE) {
          logger.warn('Output token limit reached, future requests may be delayed', {
            outputTokensThisMinute: this.outputTokensThisMinute,
            limit: KeywordExtractor.OUTPUT_TOKENS_PER_MINUTE
          });
        }

        logger.info('Claude Response Parsed:', {
          timestamp: new Date().toISOString(),
          hasContent: !!data.content,
          contentLength: data.content?.[0]?.text?.length,
          model: data.model,
          estimatedOutputTokens,
          outputTokensThisMinute: this.outputTokensThisMinute
        });

        try {
          logger.info('Parsing Claude content as JSON...');
          const result = JSON.parse(cleanedContent) as KeywordExtractionResult;
          
          // Log the raw result before validation
          logger.info('Extracted Raw Result:', {
            timestamp: new Date().toISOString(),
            keys: Object.keys(result),
            preview: JSON.stringify(result).substring(0, 500) + '...'
          });

          // Validate the structure
          if (!this.validateExtractionResult(result)) {
            logger.error('Invalid extraction result structure', {
              receivedKeys: Object.keys(result),
              hasKeyStatements: Array.isArray((result as any).keyStatements),
              hasEntities: !!(result as any).entities,
              hasSearchQueries: Array.isArray((result as any).searchQueries),
              hasTechnicalDetails: !!(result as any).technicalDetails
            });
            throw new Error('Invalid response format from Claude');
          }

          // Log detailed extraction results
          logger.info('Keyword extraction completed successfully', {
            keyStatementsCount: result.keyStatements.length,
            entitiesFound: {
              organizations: result.entities.organizations.length,
              people: result.entities.people.length,
              locations: result.entities.locations.length,
              dates: result.entities.dates.length,
              amounts: result.entities.amounts.length
            },
            searchQueriesGenerated: result.searchQueries.length,
            technicalDetails: {
              attackVectors: result.technicalDetails.attackVectors.length,
              vulnerabilities: result.technicalDetails.vulnerabilities.length,
              impactedSystems: result.technicalDetails.impactedSystems.length
            }
          });

          // Log some example content for verification
          logger.debug('Extraction result examples', {
            keyStatementExample: result.keyStatements[0],
            organizationExample: result.entities.organizations[0],
            searchQueryExample: result.searchQueries[0],
            attackVectorExample: result.technicalDetails.attackVectors[0]
          });

          return result;
        } catch (parseError) {
          logger.error('Failed to parse Claude response:', {
            error: parseError,
            responsePreview: responseText.substring(0, 200) + '...',
            isJSON: this.isValidJSON(responseText)
          });
          throw new Error(`Failed to parse Claude response: ${parseError instanceof Error ? parseError.message : 'Unknown error'}`);
        }
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          logger.error('Claude API request timed out after 25 seconds', {
            error,
            requestBodyPreview: requestBody.substring(0, 200) + '...'
          });
          throw new Error('Claude API request timed out after 25 seconds');
        }
        throw error;
      }
    } catch (error) {
      logger.error('Error during keyword extraction:', {
        error,
        errorType: error instanceof Error ? error.constructor.name : typeof error,
        message: error instanceof Error ? error.message : 'Unknown error'
      });
      throw error;
    }
  }

  private buildPrompt(content: string): string {
    const prompt = `Analyze this cybersecurity incident article and extract key information. Respond in JSON format with the following structure:
{
  "keyStatements": ["list of the most important factual statements"],
  "entities": {
    "organizations": ["affected companies, organizations"],
    "people": ["key individuals involved"],
    "locations": ["relevant locations"],
    "dates": ["important dates in YYYY-MM-DD format"],
    "amounts": ["financial losses, cryptocurrency amounts"]
  },
  "searchQueries": ["list of search queries to verify the facts"],
  "technicalDetails": {
    "attackVectors": ["methods used in the attack"],
    "vulnerabilities": ["exploited vulnerabilities"],
    "impactedSystems": ["affected systems, platforms"]
  }
}

Article:
${content}`;

    logger.debug('Built extraction prompt', {
      promptLength: prompt.length,
      articleLength: content.length,
      promptStructure: 'JSON template with article content'
    });

    return prompt;
  }

  private validateExtractionResult(result: any): result is KeywordExtractionResult {
    const isValid = (
      Array.isArray(result.keyStatements) &&
      result.entities &&
      Array.isArray(result.entities.organizations) &&
      Array.isArray(result.entities.people) &&
      Array.isArray(result.entities.locations) &&
      Array.isArray(result.entities.dates) &&
      Array.isArray(result.entities.amounts) &&
      Array.isArray(result.searchQueries) &&
      result.technicalDetails &&
      Array.isArray(result.technicalDetails.attackVectors) &&
      Array.isArray(result.technicalDetails.vulnerabilities) &&
      Array.isArray(result.technicalDetails.impactedSystems)
    );

    logger.debug('Validation result for extraction response', {
      isValid,
      validationChecks: {
        hasKeyStatements: Array.isArray(result.keyStatements),
        hasEntities: !!result.entities,
        hasOrganizations: Array.isArray(result?.entities?.organizations),
        hasPeople: Array.isArray(result?.entities?.people),
        hasLocations: Array.isArray(result?.entities?.locations),
        hasDates: Array.isArray(result?.entities?.dates),
        hasAmounts: Array.isArray(result?.entities?.amounts),
        hasSearchQueries: Array.isArray(result.searchQueries),
        hasTechnicalDetails: !!result.technicalDetails,
        hasAttackVectors: Array.isArray(result?.technicalDetails?.attackVectors),
        hasVulnerabilities: Array.isArray(result?.technicalDetails?.vulnerabilities),
        hasImpactedSystems: Array.isArray(result?.technicalDetails?.impactedSystems)
      }
    });

    return isValid;
  }

  private isValidJSON(str: string): boolean {
    try {
      JSON.parse(str);
      return true;
    } catch {
      return false;
    }
  }
} 