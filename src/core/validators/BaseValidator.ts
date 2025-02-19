import { logger } from '../logger';

export abstract class BaseValidator {
  protected githubToken: string;
  protected repoOwner: string;
  protected repoName: string;

  constructor(githubToken: string, repoFullName: string) {
    this.githubToken = githubToken;
    const [owner, name] = repoFullName.split('/');
    this.repoOwner = owner;
    this.repoName = name;
    logger.info(`${this.constructor.name} initialized for repository:`, { repoOwner: owner, repoName: name });
  }

  protected async fetchFileContent(filepath: string): Promise<string> {
    try {
      logger.info('Fetching file content:', { filepath });

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
        logger.error('GitHub API error in fetchFileContent:', { 
          status: response.status, 
          statusText: response.statusText,
          error: errorText,
          filepath
        });
        throw new Error(`GitHub API error: ${response.status} ${response.statusText} - ${errorText}`);
      }

      const content = await response.text();
      logger.info('Successfully fetched file content:', { 
        filepath,
        contentLength: content.length
      });

      return content;
    } catch (error) {
      logger.error('Error fetching file content:', error);
      throw error;
    }
  }
} 