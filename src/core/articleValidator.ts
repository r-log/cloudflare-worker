import { ArticleStructure, ArticleValidationResult, ArticleFrontMatter, DuplicationCheckResult, ComparisonResult } from './types';
import { logger } from './logger';
import * as yaml from 'yaml';

const REQUIRED_SECTIONS = [
  'Summary',
  'Attackers',
  'Losses',
  'Timeline',
  'Security Failure Causes'
].map(section => section.trim());

interface OpenRouterResponse {
  choices: Array<{
    message: {
      content: string;
    };
  }>;
}

class DuplicationChecker {
  private githubToken: string;
  private repoOwner: string;
  private repoName: string;

  constructor(githubToken: string, repoFullName: string) {
    this.githubToken = githubToken;
    const [owner, name] = repoFullName.split('/');
    this.repoOwner = owner;
    this.repoName = name;
    logger.info('DuplicationChecker initialized for repository:', { repoOwner: owner, repoName: name });
  }

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

  private async fetchExistingArticle(filepath: string): Promise<string> {
    try {
      logger.info('Fetching article content:', { filepath });

      const response = await fetch(
        `https://api.github.com/repos/${this.repoOwner}/${this.repoName}/contents/${filepath}`,
        {
          headers: {
            'Authorization': `Bearer ${this.githubToken}`,
            'Accept': 'application/vnd.github.v3.raw',
            'User-Agent': 'ArticleChecker-Bot'
          }
        }
      );

      if (!response.ok) {
        const errorText = await response.text();
        logger.error('GitHub API error in fetchExistingArticle:', { 
          status: response.status, 
          statusText: response.statusText,
          error: errorText,
          filepath
        });
        throw new Error(`GitHub API error: ${response.status} ${response.statusText} - ${errorText}`);
      }

      const content = await response.text();
      logger.info('Successfully fetched article content:', { 
        filepath,
        contentLength: content.length
      });

      return content;
    } catch (error) {
      logger.error('Error fetching existing article:', error);
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
        
        const existingContent = await this.fetchExistingArticle(existingFile);
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

export class ArticleValidator {
  private duplicationChecker: DuplicationChecker;

  constructor(githubToken: string, repoFullName: string) {
    this.duplicationChecker = new DuplicationChecker(githubToken, repoFullName);
  }

  private validateFrontMatter(frontMatter: ArticleFrontMatter): { isValid: boolean; errors: string[] } {
    const errors: string[] = [];

    // Check date format (YYYY-MM-DD)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(frontMatter.date)) {
      errors.push('Date must be in YYYY-MM-DD format');
    }

    // Check required fields
    if (!frontMatter['target-entities']) {
      errors.push('target-entities is required');
    }
    if (!Array.isArray(frontMatter['entity-types']) || frontMatter['entity-types'].length === 0) {
      errors.push('entity-types must be a non-empty array');
    }
    if (!frontMatter['attack-types']) {
      errors.push('attack-types is required');
    }
    if (!frontMatter.title) {
      errors.push('title is required');
    }
    if (typeof frontMatter.loss !== 'number') {
      errors.push('loss must be a number');
    }

    return {
      isValid: errors.length === 0,
      errors
    };
  }

  private parseFrontMatter(content: string): { frontMatter: ArticleFrontMatter | null; errors: string[] } {
    const errors: string[] = [];
    try {
      const match = content.match(/^---\n([\s\S]*?)\n---/);
      if (!match) {
        errors.push('Front matter not found or invalid format');
        return { frontMatter: null, errors };
      }

      const frontMatter = yaml.parse(match[1]) as ArticleFrontMatter;
      return { frontMatter, errors };
    } catch (error) {
      logger.error('Error parsing front matter:', error);
      errors.push('Failed to parse front matter: ' + (error instanceof Error ? error.message : 'Unknown error'));
      return { frontMatter: null, errors };
    }
  }

  private extractSections(content: string): { sections: Record<string, string>; errors: string[] } {
    const errors: string[] = [];
    const sections: Record<string, string> = {};
    
    // Remove front matter
    const contentWithoutFrontMatter = content.replace(/^---\n[\s\S]*?\n---\n/, '').trim();
    
    // Split content into sections using a more robust regex
    const sectionMatches = contentWithoutFrontMatter.match(/(?:^|\n)## ([^\n]+)([^#]*?)(?=\n## |$)/g);
    
    if (!sectionMatches) {
      errors.push('No sections found in the article');
      logger.debug('Content after front matter removal:', { contentWithoutFrontMatter });
      return { sections, errors };
    }

    sectionMatches.forEach(section => {
      // Extract section title and content more reliably
      const titleMatch = section.match(/## ([^\n]+)/);
      if (titleMatch) {
        const sectionName = titleMatch[1].trim();
        const content = section.replace(/## [^\n]+\n/, '').trim();
        sections[sectionName] = content;
        logger.debug('Extracted section:', { sectionName, contentLength: content.length });
      }
    });

    // Log found sections for debugging
    logger.debug('Found sections:', { 
      sectionNames: Object.keys(sections),
      requiredSections: REQUIRED_SECTIONS
    });

    return { sections, errors };
  }

  public async validateArticle(content: string, filename: string, openRouterApiKey: string): Promise<ArticleValidationResult> {
    const result: ArticleValidationResult = {
      isValid: false,
      errors: [],
      warnings: [],
      frontMatterValid: false,
      sectionsValid: false,
      missingRequiredSections: [],
      additionalSections: [],
      duplicationCheck: undefined
    };

    try {
      // First check for duplicates
      const duplicationCheck = await this.duplicationChecker.checkDuplication(content, filename, openRouterApiKey);
      result.duplicationCheck = duplicationCheck;

      if (duplicationCheck.isDuplicate) {
        // For duplicates, only include duplication-related error message
        result.errors = [`Article is a duplicate of existing file: ${duplicationCheck.existingFilePath}`];
        return result;
      }

      // Only proceed with other validations if not a duplicate
      const { frontMatter, errors: frontMatterErrors } = this.parseFrontMatter(content);
      result.errors.push(...frontMatterErrors);

      if (frontMatter) {
        const { isValid, errors } = this.validateFrontMatter(frontMatter);
        result.frontMatterValid = isValid;
        result.errors.push(...errors);
      }

      // Extract and validate sections
      const { sections, errors: sectionErrors } = this.extractSections(content);
      result.errors.push(...sectionErrors);

      // Check for required sections
      REQUIRED_SECTIONS.forEach(section => {
        if (!sections[section]) {
          result.missingRequiredSections.push(section);
        }
      });

      // Check for additional sections
      Object.keys(sections).forEach(section => {
        if (!REQUIRED_SECTIONS.includes(section)) {
          result.additionalSections.push(section);
        }
      });

      // Validate section content
      Object.entries(sections).forEach(([section, content]) => {
        if (!content.trim()) {
          result.errors.push(`Section "${section}" is empty`);
        }
      });

      result.sectionsValid = result.missingRequiredSections.length === 0;
    } catch (error) {
      logger.error('Error during article validation:', error);
      result.errors.push('Internal validation error: ' + (error instanceof Error ? error.message : 'Unknown error'));
    }

    result.isValid = result.frontMatterValid && result.sectionsValid && result.errors.length === 0;
    return result;
  }
} 