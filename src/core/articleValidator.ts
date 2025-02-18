import { ArticleStructure, ArticleValidationResult, ArticleFrontMatter } from './types';
import { logger } from './logger';
import * as yaml from 'yaml';

const REQUIRED_SECTIONS = [
  'Summary',
  'Attackers',
  'Losses',
  'Timeline',
  'Security Failure Causes'
].map(section => section.trim());

export class ArticleValidator {
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

  public validateArticle(content: string): ArticleValidationResult {
    const result: ArticleValidationResult = {
      isValid: false,
      errors: [],
      warnings: [],
      frontMatterValid: false,
      sectionsValid: false,
      missingRequiredSections: [],
      additionalSections: []
    };

    // Parse and validate front matter
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
    result.isValid = result.frontMatterValid && result.sectionsValid && result.errors.length === 0;

    return result;
  }
} 