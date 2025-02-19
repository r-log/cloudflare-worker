import { logger } from '../logger';

export const REQUIRED_SECTIONS = [
  'Summary',
  'Attackers',
  'Losses',
  'Timeline',
  'Security Failure Causes'
].map(section => section.trim());

export class SectionValidator {
  public extractSections(content: string): { sections: Record<string, string>; errors: string[] } {
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

  public validateSections(sections: Record<string, string>): {
    isValid: boolean;
    errors: string[];
    missingRequired: string[];
    additional: string[];
  } {
    const errors: string[] = [];
    const missingRequired: string[] = [];
    const additional: string[] = [];

    // Check for required sections
    REQUIRED_SECTIONS.forEach(section => {
      if (!sections[section]) {
        missingRequired.push(section);
      }
    });

    // Check for additional sections
    Object.keys(sections).forEach(section => {
      if (!REQUIRED_SECTIONS.includes(section)) {
        additional.push(section);
      }
    });

    // Validate section content
    Object.entries(sections).forEach(([section, content]) => {
      if (!content.trim()) {
        errors.push(`Section "${section}" is empty`);
      }
    });

    return {
      isValid: missingRequired.length === 0 && errors.length === 0,
      errors,
      missingRequired,
      additional
    };
  }
} 