import { ArticleFrontMatter } from '../types';
import { logger } from '../logger';
import * as yaml from 'yaml';

export class FrontMatterValidator {
  public parseFrontMatter(content: string): { frontMatter: ArticleFrontMatter | null; errors: string[] } {
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

  public validateFrontMatter(frontMatter: ArticleFrontMatter): { isValid: boolean; errors: string[] } {
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
} 