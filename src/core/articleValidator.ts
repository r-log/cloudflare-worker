import { ArticleValidationResult, FactCheckResult } from './types';
import { logger } from './logger';
import { DuplicationChecker } from './checkers/DuplicationChecker';
import { FrontMatterValidator } from './validators/FrontMatterValidator';
import { SectionValidator } from './validators/SectionValidator';
import { KeywordExtractor } from './analyzers/KeywordExtractor';
import { SourceSearcher } from './analyzers/SourceSearcher';
import { FactChecker } from './analyzers/FactChecker';

export class ArticleValidator {
  private duplicationChecker: DuplicationChecker;
  private frontMatterValidator: FrontMatterValidator;
  private sectionValidator: SectionValidator;
  private keywordExtractor: KeywordExtractor;
  private sourceSearcher: SourceSearcher;
  private factChecker: FactChecker;

  constructor(
    githubToken: string,
    repoFullName: string,
    claudeApiKey: string,
    braveApiKey: string
  ) {
    this.duplicationChecker = new DuplicationChecker(githubToken, repoFullName);
    this.frontMatterValidator = new FrontMatterValidator();
    this.sectionValidator = new SectionValidator();
    this.keywordExtractor = new KeywordExtractor(claudeApiKey);
    this.sourceSearcher = new SourceSearcher(braveApiKey);
    this.factChecker = new FactChecker(claudeApiKey);
  }

  public async validateArticle(
    content: string,
    filename: string,
    openRouterApiKey: string
  ): Promise<ArticleValidationResult> {
    const result: ArticleValidationResult = {
      isValid: false,
      errors: [],
      warnings: [],
      frontMatterValid: false,
      sectionsValid: false,
      missingRequiredSections: [],
      additionalSections: [],
      duplicationCheck: undefined,
      factCheck: undefined
    };

    try {
      // First check for duplicates
      const duplicationCheck = await this.duplicationChecker.checkDuplication(content, filename, openRouterApiKey);
      result.duplicationCheck = duplicationCheck;

      if (duplicationCheck.isDuplicate) {
        result.errors = [`Article is a duplicate of existing file: ${duplicationCheck.existingFilePath}`];
        return result;
      }

      // Validate front matter and sections
      const { frontMatter, errors: frontMatterErrors } = this.frontMatterValidator.parseFrontMatter(content);
      result.errors.push(...frontMatterErrors);

      if (frontMatter) {
        const { isValid, errors } = this.frontMatterValidator.validateFrontMatter(frontMatter);
        result.frontMatterValid = isValid;
        result.errors.push(...errors);
      }

      const { sections, errors: sectionErrors } = this.sectionValidator.extractSections(content);
      result.errors.push(...sectionErrors);

      const sectionValidation = this.sectionValidator.validateSections(sections);
      result.sectionsValid = sectionValidation.isValid;
      result.errors.push(...sectionValidation.errors);
      result.missingRequiredSections = sectionValidation.missingRequired;
      result.additionalSections = sectionValidation.additional;

      // Only proceed with fact checking if basic validation passes
      if (result.frontMatterValid && result.sectionsValid) {
        try {
          logger.info('Starting fact-checking pipeline');

          // Extract keywords and statements
          const extractedInfo = await this.keywordExtractor.extract(content);
          logger.info('Keywords extracted', {
            keyStatementsCount: extractedInfo.keyStatements.length,
            entitiesFound: Object.keys(extractedInfo.entities).length
          });

          // Find relevant sources
          const sources = await this.sourceSearcher.findSources(extractedInfo.searchQueries);
          logger.info('Sources found', { sourcesCount: sources.length });

          // Verify facts
          const factCheckResult = await this.factChecker.verifyFacts(extractedInfo, sources);
          result.factCheck = factCheckResult;

          // Add warnings for unreliable facts
          factCheckResult.unreliableFacts.forEach(fact => {
            result.warnings.push(`Potentially unreliable fact: ${fact.statement}\nReason: ${fact.reason}`);
            if (fact.suggestedCorrection) {
              result.warnings.push(`Suggested correction: ${fact.suggestedCorrection}`);
            }
          });

          // Update overall validation based on fact check results
          if (factCheckResult.confidence < 0.7) {
            result.warnings.push(`Low fact verification confidence (${(factCheckResult.confidence * 100).toFixed(1)}%). Some facts may need additional verification.`);
          }

          logger.info('Fact-checking completed', {
            verifiedFacts: factCheckResult.verifiedFacts.length,
            unreliableFacts: factCheckResult.unreliableFacts.length,
            overallConfidence: factCheckResult.confidence
          });
        } catch (factCheckError) {
          logger.error('Error during fact-checking:', factCheckError);
          result.warnings.push('Fact-checking process encountered an error: ' + 
            (factCheckError instanceof Error ? factCheckError.message : 'Unknown error'));
        }
      }

    } catch (error) {
      logger.error('Error during article validation:', error);
      result.errors.push('Internal validation error: ' + (error instanceof Error ? error.message : 'Unknown error'));
    }

    result.isValid = result.frontMatterValid && 
                    result.sectionsValid && 
                    result.errors.length === 0 &&
                    (!result.factCheck || result.factCheck.confidence >= 0.7);
    return result;
  }
} 