import { FactCheckResult, KeywordExtractionResult, Source, VerifiedFact, UnreliableFact } from '../types';
import { logger } from '../logger';

interface ClaudeResponse {
  content: [{
    text: string;
  }];
  model: string;
  role: string;
}

export class FactChecker {
  private claudeApiKey: string;
  private minConfidenceThreshold: number;

  constructor(claudeApiKey: string, minConfidenceThreshold = 0.7) {
    this.claudeApiKey = claudeApiKey;
    this.minConfidenceThreshold = minConfidenceThreshold;
  }

  public async verifyFacts(
    extractedInfo: KeywordExtractionResult,
    sources: Source[]
  ): Promise<FactCheckResult> {
    try {
      logger.info('Starting fact verification', {
        statementsCount: extractedInfo.keyStatements.length,
        sourcesCount: sources.length,
        sourceReliabilities: sources.map(s => ({ domain: s.domain, reliability: s.reliability }))
      });

      // If we have many statements or sources, split into chunks
      const CHUNK_SIZE = 5; // Process 5 statements at a time
      const chunks: KeywordExtractionResult[] = [];
      
      if (extractedInfo.keyStatements.length > CHUNK_SIZE) {
        logger.info('Splitting verification into chunks', {
          totalStatements: extractedInfo.keyStatements.length,
          chunkSize: CHUNK_SIZE
        });

        // Split statements into chunks
        for (let i = 0; i < extractedInfo.keyStatements.length; i += CHUNK_SIZE) {
          const chunk: KeywordExtractionResult = {
            ...extractedInfo,
            keyStatements: extractedInfo.keyStatements.slice(i, i + CHUNK_SIZE)
          };
          chunks.push(chunk);
        }
      } else {
        chunks.push(extractedInfo);
      }

      // Process each chunk with retries
      const results: FactCheckResult[] = [];
      for (let i = 0; i < chunks.length; i++) {
        logger.info('Processing chunk', {
          chunkNumber: i + 1,
          totalChunks: chunks.length,
          statementsInChunk: chunks[i].keyStatements.length
        });

        const chunkResult = await this.verifyFactsChunk(chunks[i], sources);
        results.push(chunkResult);
      }

      // Merge results
      const mergedResult: FactCheckResult = {
        isFactual: results.every(r => r.isFactual),
        verifiedFacts: results.flatMap(r => r.verifiedFacts),
        unreliableFacts: results.flatMap(r => r.unreliableFacts),
        sourcesUsed: Array.from(new Set(results.flatMap(r => r.sourcesUsed))),
        confidence: results.reduce((sum, r) => sum + r.confidence, 0) / results.length
      };

      logger.info('Completed fact verification', {
        totalVerifiedFacts: mergedResult.verifiedFacts.length,
        totalUnreliableFacts: mergedResult.unreliableFacts.length,
        overallConfidence: mergedResult.confidence
      });

      return mergedResult;
    } catch (error) {
      logger.error('Error during fact verification:', {
        error,
        errorType: error instanceof Error ? error.constructor.name : typeof error,
        message: error instanceof Error ? error.message : 'Unknown error',
        statementsCount: extractedInfo?.keyStatements?.length,
        sourcesCount: sources?.length
      });
      throw error;
    }
  }

  private async verifyFactsChunk(
    extractedInfo: KeywordExtractionResult,
    sources: Source[],
    maxRetries = 3
  ): Promise<FactCheckResult> {
    let lastError: Error | null = null;
    
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const prompt = this.buildVerificationPrompt(extractedInfo, sources);
        
        logger.info('Attempting verification', {
          attempt: attempt + 1,
          maxRetries,
          statementsCount: extractedInfo.keyStatements.length
        });

        const verificationResult = await this.analyzeWithClaude(prompt);
        return verificationResult;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        
        if (attempt < maxRetries - 1) {
          const delay = Math.min(1000 * Math.pow(2, attempt), 8000); // Max 8 second delay
          const jitter = Math.random() * 1000; // Add up to 1 second of jitter
          
          logger.warn('Verification attempt failed, retrying', {
            attempt: attempt + 1,
            maxRetries,
            error: lastError.message,
            nextRetryDelay: delay + jitter
          });
          
          await new Promise(resolve => setTimeout(resolve, delay + jitter));
        }
      }
    }

    throw lastError || new Error('All verification attempts failed');
  }

  private buildVerificationPrompt(
    extractedInfo: KeywordExtractionResult,
    sources: Source[]
  ): string {
    // Limit sources to most reliable ones to reduce prompt size
    const MAX_SOURCES = 8;
    const sortedSources = [...sources]
      .sort((a, b) => b.reliability - a.reliability)
      .slice(0, MAX_SOURCES);

    // Truncate long snippets
    const processedSources = sortedSources.map(src => ({
      ...src,
      snippet: src.snippet.length > 300 ? src.snippet.substring(0, 300) + '...' : src.snippet
    }));

    // Build a more concise prompt with explicit confidence instructions
    return `Verify these statements against the sources. Respond in JSON only. All confidence values MUST be between 0 and 1 (e.g., 0.85 for 85% confidence).

Statements:
${extractedInfo.keyStatements.map((stmt, i) => `${i + 1}. ${stmt}`).join('\n')}

Key Details:
${[
  extractedInfo.technicalDetails.attackVectors.length > 0 ? `Attack Vectors: ${extractedInfo.technicalDetails.attackVectors.join(', ')}` : null,
  extractedInfo.technicalDetails.vulnerabilities.length > 0 ? `Vulnerabilities: ${extractedInfo.technicalDetails.vulnerabilities.join(', ')}` : null,
  extractedInfo.technicalDetails.impactedSystems.length > 0 ? `Impacted Systems: ${extractedInfo.technicalDetails.impactedSystems.join(', ')}` : null
].filter(Boolean).join('\n')}

Sources:
${processedSources.map((src, i) => 
  `[${i + 1}] ${src.title} (${src.domain}) - ${src.snippet}`
).join('\n')}

Response format (all confidence values MUST be between 0 and 1):
{
  "isFactual": boolean,
  "verifiedFacts": [{"statement": "text", "confidence": number (0-1), "sources": [{"url": "url", "title": "title"}]}],
  "unreliableFacts": [{"statement": "text", "reason": "why"}],
  "sourcesUsed": [{"url": "url", "title": "title", "reliability": number (0-1)}],
  "confidence": number (0-1)
}`;
  }

  private normalizeConfidence(value: number): number {
    // If value is greater than 1, assume it's a percentage and convert
    if (value > 1) {
      const normalized = value / 100;
      logger.debug('Normalized confidence value:', {
        original: value,
        normalized,
        reason: 'Value > 1 converted from percentage'
      });
      return Math.min(1, Math.max(0, normalized));
    }
    return Math.min(1, Math.max(0, value));
  }

  private cleanMarkdownJSON(text: string): string {
    try {
      // Log the original text for debugging
      logger.debug('Cleaning response text:', {
        originalLength: text.length,
        startsWithMarkdown: text.trim().startsWith('```'),
        containsMarkdown: text.includes('```'),
        preview: text.substring(0, 100)
      });

      // Remove markdown code block syntax
      let cleaned = text.replace(/^```(?:json)?\s*|\s*```$/g, '').trim();

      // Ensure the text starts with { and ends with }
      if (!cleaned.startsWith('{') || !cleaned.endsWith('}')) {
        logger.error('Cleaned response is not a valid JSON object:', {
          startsWithBrace: cleaned.startsWith('{'),
          endsWithBrace: cleaned.endsWith('}'),
          preview: cleaned.substring(0, 100)
        });
        throw new Error('Response is not a valid JSON object');
      }

      // Validate that it's parseable JSON
      JSON.parse(cleaned); // This will throw if invalid

      logger.debug('Successfully cleaned response:', {
        cleanedLength: cleaned.length,
        preview: cleaned.substring(0, 100)
      });

      return cleaned;
    } catch (error) {
      logger.error('Error cleaning response JSON:', {
        error,
        originalText: text.substring(0, 200),
        errorType: error instanceof Error ? error.constructor.name : typeof error,
        message: error instanceof Error ? error.message : 'Unknown error'
      });
      throw error;
    }
  }

  private async analyzeWithClaude(prompt: string): Promise<FactCheckResult> {
    try {
      const requestBody = JSON.stringify({
        model: 'claude-3-sonnet-20240229',
        max_tokens: 4096,
        messages: [{
          role: 'user',
          content: prompt
        }]
      });

      const requestSize = new TextEncoder().encode(requestBody).length;
      logger.info('Preparing Claude API request', {
        timestamp: new Date().toISOString(),
        requestSizeBytes: requestSize,
        requestSizeKB: Math.round(requestSize / 1024),
        modelUsed: 'claude-3-sonnet-20240229'
      });

      if (requestSize > 100000) { // 100KB limit
        logger.error('Request too large', {
          requestSizeKB: Math.round(requestSize / 1024),
          timestamp: new Date().toISOString()
        });
        throw new Error('Request payload too large');
      }

      // Create AbortController for timeout
      const controller = new AbortController();
      let timeoutId: number | undefined;

      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          logger.error('Claude API request timeout initiated', {
            timestamp: new Date().toISOString(),
            requestSizeKB: Math.round(requestSize / 1024)
          });
          controller.abort();
          reject(new Error('Claude API request timed out after 20 seconds'));
        }, 20000) as unknown as number; // Increased to 20 second timeout
      });

      try {
        logger.info('Starting Claude API fetch', {
          timestamp: new Date().toISOString(),
          requestSizeKB: Math.round(requestSize / 1024)
        });

        // Race between the fetch and the timeout
        const response = await Promise.race([
          fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': this.claudeApiKey,
              'anthropic-version': '2023-06-01'
            },
            body: requestBody,
            signal: controller.signal
          }),
          timeoutPromise
        ]);

        // Clear timeout since we got a response
        if (timeoutId) clearTimeout(timeoutId);

        // Log response headers immediately
        logger.info('Claude API Response Headers:', {
          status: response.status,
          statusText: response.statusText,
          headers: {
            contentType: response.headers.get('content-type'),
            contentLength: response.headers.get('content-length')
          },
          timestamp: new Date().toISOString()
        });

        if (!response.ok) {
          const errorText = await response.text();
          logger.error('Claude API error:', {
            status: response.status,
            statusText: response.statusText,
            error: errorText,
            requestSize: requestBody.length,
            responseSize: errorText.length,
            timestamp: new Date().toISOString()
          });

          // Handle specific error cases
          if (response.status === 429) {
            throw new Error('Claude API rate limit exceeded');
          } else if (response.status === 500) {
            throw new Error('Claude API internal server error');
          } else if (response.status === 503) {
            throw new Error('Claude API service unavailable');
          }
          
          throw new Error(`Claude API error: ${response.status} ${response.statusText} - ${errorText}`);
        }

        // Start reading response body with a separate timeout
        logger.info('Starting to read Claude API response', {
          timestamp: new Date().toISOString()
        });

        const bodyTimeoutPromise = new Promise<never>((_, reject) => {
          setTimeout(() => {
            logger.error('Claude API response reading timeout initiated', {
              timestamp: new Date().toISOString()
            });
            controller.abort();
            reject(new Error('Claude API response reading timed out after 15 seconds'));
          }, 15000);
        });

        const responseText = await Promise.race([
          response.text(),
          bodyTimeoutPromise
        ]);

        logger.info('Successfully read Claude API response', {
          responseLength: responseText.length,
          timestamp: new Date().toISOString()
        });

        const data = JSON.parse(responseText) as ClaudeResponse;

        if (!data.content?.[0]?.text) {
          logger.error('Invalid Claude API response format:', {
            responseKeys: Object.keys(data),
            hasContent: !!data.content,
            contentLength: data.content?.length
          });
          throw new Error('Invalid Claude API response format');
        }

        const rawContent = data.content[0].text;

        // Log raw response for debugging
        logger.debug('Raw Claude response:', {
          contentLength: rawContent.length,
          preview: rawContent.substring(0, 200) + '...',
          hasMarkdown: rawContent.includes('```'),
          timestamp: new Date().toISOString()
        });

        // Clean markdown formatting if present
        const cleanedContent = this.cleanMarkdownJSON(rawContent);
        
        logger.debug('Cleaned response:', {
          originalLength: rawContent.length,
          cleanedLength: cleanedContent.length,
          startsWithBrace: cleanedContent.trim().startsWith('{'),
          preview: cleanedContent.substring(0, 200) + '...',
          timestamp: new Date().toISOString()
        });

        try {
          const result = JSON.parse(cleanedContent) as FactCheckResult;
          
          // Validate the structure
          if (!this.validateFactCheckResult(result)) {
            logger.error('Invalid fact check result structure', {
              receivedKeys: Object.keys(result),
              hasVerifiedFacts: Array.isArray((result as any).verifiedFacts),
              hasUnreliableFacts: Array.isArray((result as any).unreliableFacts),
              hasSourcesUsed: Array.isArray((result as any).sourcesUsed)
            });
            throw new Error('Invalid response format from Claude');
          }

          // Process and validate the results
          result.verifiedFacts = this.processVerifiedFacts(result.verifiedFacts);
          result.unreliableFacts = this.processUnreliableFacts(result.unreliableFacts);
          result.confidence = this.calculateOverallConfidence(result);

          logger.info('Successfully processed fact check result', {
            verifiedFactsCount: result.verifiedFacts.length,
            unreliableFactsCount: result.unreliableFacts.length,
            sourcesUsedCount: result.sourcesUsed.length,
            confidence: result.confidence,
            timestamp: new Date().toISOString()
          });

          return result;
        } catch (parseError) {
          logger.error('Failed to parse Claude response:', {
            error: parseError,
            responsePreview: cleanedContent.substring(0, 200) + '...',
            isJSON: this.isValidJSON(cleanedContent),
            timestamp: new Date().toISOString()
          });
          throw new Error(`Failed to parse Claude response: ${parseError instanceof Error ? parseError.message : 'Unknown error'}`);
        }
      } catch (fetchError: unknown) {
        if (fetchError instanceof Error && fetchError.name === 'AbortError') {
          logger.error('Claude API request aborted:', {
            error: fetchError,
            requestSize: requestBody.length,
            timestamp: new Date().toISOString()
          });
          throw new Error('Claude API request timed out or was aborted');
        }
        throw fetchError;
      }
    } catch (error) {
      logger.error('Error in analyzeWithClaude:', {
        error,
        errorType: error instanceof Error ? error.constructor.name : typeof error,
        message: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString()
      });
      throw error;
    }
  }

  private isValidJSON(str: string): boolean {
    try {
      JSON.parse(str);
      return true;
    } catch {
      return false;
    }
  }

  private validateFactCheckResult(result: any): result is FactCheckResult {
    try {
      // Log the full structure for debugging
      logger.debug('Validating fact check result structure:', {
        resultKeys: Object.keys(result),
        verifiedFactsType: Array.isArray(result.verifiedFacts) ? 'array' : typeof result.verifiedFacts,
        verifiedFactsLength: result.verifiedFacts?.length,
        verifiedFactsExample: result.verifiedFacts?.[0],
        unreliableFactsType: Array.isArray(result.unreliableFacts) ? 'array' : typeof result.unreliableFacts,
        sourcesUsedType: Array.isArray(result.sourcesUsed) ? 'array' : typeof result.sourcesUsed,
        confidenceType: typeof result.confidence,
        rawConfidence: result.confidence
      });

      // Basic structure validation
      if (!result || typeof result !== 'object') {
        logger.error('Result is not an object');
        return false;
      }

      // Validate isFactual
      if (typeof result.isFactual !== 'boolean') {
        logger.error('isFactual is not a boolean:', { type: typeof result.isFactual });
        return false;
      }

      // Validate arrays
      if (!Array.isArray(result.verifiedFacts)) {
        logger.error('verifiedFacts is not an array:', { type: typeof result.verifiedFacts });
        return false;
      }

      if (!Array.isArray(result.unreliableFacts)) {
        logger.error('unreliableFacts is not an array:', { type: typeof result.unreliableFacts });
        return false;
      }

      if (!Array.isArray(result.sourcesUsed)) {
        logger.error('sourcesUsed is not an array:', { type: typeof result.sourcesUsed });
        return false;
      }

      // Normalize and validate confidence
      if (typeof result.confidence !== 'number') {
        logger.error('confidence is not a number:', { type: typeof result.confidence });
        return false;
      }
      result.confidence = this.normalizeConfidence(result.confidence);

      // Validate verifiedFacts structure
      for (const [index, fact] of result.verifiedFacts.entries()) {
        if (!fact || typeof fact !== 'object') {
          logger.error(`Invalid verifiedFact at index ${index}:`, { fact });
          return false;
        }
        if (typeof fact.statement !== 'string' || fact.statement.trim() === '') {
          logger.error(`Invalid statement in verifiedFact at index ${index}:`, { statement: fact.statement });
          return false;
        }
        if (typeof fact.confidence !== 'number') {
          logger.error(`Invalid confidence in verifiedFact at index ${index}:`, { confidence: fact.confidence });
          return false;
        }
        fact.confidence = this.normalizeConfidence(fact.confidence);
        if (!Array.isArray(fact.sources)) {
          logger.error(`Invalid sources in verifiedFact at index ${index}:`, { sources: fact.sources });
          return false;
        }
      }

      // Validate unreliableFacts structure
      for (const [index, fact] of result.unreliableFacts.entries()) {
        if (!fact || typeof fact !== 'object') {
          logger.error(`Invalid unreliableFact at index ${index}:`, { fact });
          return false;
        }
        if (typeof fact.statement !== 'string' || fact.statement.trim() === '') {
          logger.error(`Invalid statement in unreliableFact at index ${index}:`, { statement: fact.statement });
          return false;
        }
        if (typeof fact.reason !== 'string' || fact.reason.trim() === '') {
          logger.error(`Invalid reason in unreliableFact at index ${index}:`, { reason: fact.reason });
          return false;
        }
      }

      // If we get here, all validations passed
      logger.debug('Fact check result validation passed', {
        normalizedConfidence: result.confidence,
        verifiedFactsCount: result.verifiedFacts.length,
        unreliableFactsCount: result.unreliableFacts.length
      });
      return true;
    } catch (error) {
      logger.error('Error during fact check result validation:', error);
      return false;
    }
  }

  private processVerifiedFacts(facts: VerifiedFact[]): VerifiedFact[] {
    return facts
      .filter(fact => fact.confidence >= this.minConfidenceThreshold)
      .sort((a, b) => b.confidence - a.confidence);
  }

  private processUnreliableFacts(facts: UnreliableFact[]): UnreliableFact[] {
    return facts.filter(fact => fact.reason && fact.statement);
  }

  private calculateOverallConfidence(result: FactCheckResult): number {
    try {
      if (result.verifiedFacts.length === 0) {
        logger.debug('No verified facts, returning 0 confidence');
        return 0;
      }

      // Calculate weighted confidence based on individual fact confidences
      const totalConfidence = result.verifiedFacts.reduce((sum, fact) => sum + fact.confidence, 0);
      const averageConfidence = totalConfidence / result.verifiedFacts.length;

      // Calculate verification ratio (verified vs total facts)
      const totalFacts = result.verifiedFacts.length + result.unreliableFacts.length;
      const verifiedRatio = result.verifiedFacts.length / totalFacts;

      // Calculate source reliability factor
      const sourceReliabilitySum = result.sourcesUsed.reduce((sum, source) => sum + (source.reliability || 0), 0);
      const averageSourceReliability = result.sourcesUsed.length > 0 ? 
        sourceReliabilitySum / result.sourcesUsed.length : 0.5;

      // Weighted components
      const weights = {
        averageConfidence: 0.4,    // 40% weight for average fact confidence
        verifiedRatio: 0.3,        // 30% weight for ratio of verified facts
        sourceReliability: 0.3     // 30% weight for source reliability
      };

      const confidence = (
        (averageConfidence * weights.averageConfidence) +
        (verifiedRatio * weights.verifiedRatio) +
        (averageSourceReliability * weights.sourceReliability)
      );

      logger.debug('Calculated overall confidence:', {
        averageFactConfidence: averageConfidence,
        verifiedRatio,
        averageSourceReliability,
        finalConfidence: confidence,
        verifiedFactsCount: result.verifiedFacts.length,
        unreliableFactsCount: result.unreliableFacts.length,
        sourcesCount: result.sourcesUsed.length
      });

      return confidence;
    } catch (error) {
      logger.error('Error calculating overall confidence:', error);
      // Return a conservative confidence value on error
      return Math.min(
        result.verifiedFacts.reduce((min, fact) => Math.min(min, fact.confidence), 1),
        0.5
      );
    }
  }
} 