import { Source } from '../types';
import { logger } from '../logger';

interface BraveSearchResponse {
  web: {
    results: Array<{
      title: string;
      url: string;
      description: string;
      age: string;
      domain: string;
    }>;
  };
}

export class SourceSearcher {
  private braveApiKey: string;
  private maxResultsPerQuery: number;
  private minReliabilityScore: number;

  constructor(braveApiKey: string, maxResultsPerQuery = 5, minReliabilityScore = 0.6) {
    this.braveApiKey = braveApiKey;
    this.maxResultsPerQuery = maxResultsPerQuery;
    this.minReliabilityScore = minReliabilityScore;
  }

  public async findSources(searchQueries: string[]): Promise<Source[]> {
    try {
      logger.info('Starting source search', { 
        queryCount: searchQueries.length,
        maxResultsPerQuery: this.maxResultsPerQuery 
      });

      const allSources: Source[] = [];
      const seenUrls = new Set<string>();

      for (const query of searchQueries) {
        const sources = await this.searchBrave(query);
        
        // Filter out duplicates and low reliability sources
        for (const source of sources) {
          if (!seenUrls.has(source.url) && source.reliability >= this.minReliabilityScore) {
            allSources.push(source);
            seenUrls.add(source.url);
          }
        }

        // Respect rate limits
        await new Promise(resolve => setTimeout(resolve, 200));
      }

      logger.info('Source search completed', { 
        totalSourcesFound: allSources.length,
        uniqueDomains: [...new Set(allSources.map(s => s.domain))].length
      });

      return allSources;
    } catch (error) {
      logger.error('Error during source search:', error);
      throw error;
    }
  }

  private async searchBrave(query: string): Promise<Source[]> {
    try {
      logger.debug('Executing Brave search query:', { query });

      const response = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}`, {
        headers: {
          'Accept': 'application/json',
          'Accept-Encoding': 'gzip',
          'X-Subscription-Token': this.braveApiKey
        }
      });

      if (!response.ok) {
        const errorText = await response.text();
        logger.error('Brave Search API error:', {
          status: response.status,
          statusText: response.statusText,
          error: errorText,
          query
        });
        throw new Error(`Brave Search API error: ${response.status} ${response.statusText} - ${errorText}`);
      }

      const data = await response.json() as BraveSearchResponse;
      
      if (!data.web?.results) {
        logger.warn('No results from Brave search:', { query });
        return [];
      }

      const sources: Source[] = data.web.results
        .slice(0, this.maxResultsPerQuery)
        .map(result => {
          // Extract domain from URL if not provided by API
          const domain = result.domain || this.extractDomainFromUrl(result.url);
          const reliability = this.calculateReliability({ ...result, domain });
          return {
            url: result.url,
            title: result.title,
            snippet: result.description,
            publishDate: this.parsePublishDate(result.age),
            domain,
            reliability
          };
        })
        .filter(source => source.reliability >= this.minReliabilityScore);

      logger.debug('Processed search results:', { 
        query,
        resultsFound: sources.length,
        domains: sources.map(s => s.domain),
        reliabilityScores: sources.map(s => s.reliability)
      });

      return sources;
    } catch (error) {
      logger.error('Error searching Brave:', { error, query });
      throw error;
    }
  }

  private extractDomainFromUrl(url: string): string {
    try {
      const urlObj = new URL(url);
      const domain = urlObj.hostname.toLowerCase();
      logger.debug('Extracted domain from URL:', { url, domain });
      return domain;
    } catch (error) {
      logger.warn('Failed to extract domain from URL:', { url, error });
      return '';
    }
  }

  private parsePublishDate(age: string): string | undefined {
    try {
      if (!age) return undefined;
      
      // Convert relative age to ISO date
      const now = new Date();
      const matches = age.match(/(\d+)\s+(day|month|year)s?\s+ago/i);
      
      if (matches) {
        const [, amount, unit] = matches;
        const date = new Date(now);
        
        switch (unit.toLowerCase()) {
          case 'day':
            date.setDate(date.getDate() - parseInt(amount));
            break;
          case 'month':
            date.setMonth(date.getMonth() - parseInt(amount));
            break;
          case 'year':
            date.setFullYear(date.getFullYear() - parseInt(amount));
            break;
        }
        
        return date.toISOString().split('T')[0];
      }
      
      return undefined;
    } catch (error) {
      logger.warn('Error parsing publish date:', { error, age });
      return undefined;
    }
  }

  private calculateReliability(result: BraveSearchResponse['web']['results'][0]): number {
    try {
      let score = 0.5; // Base score

      // Domain-based scoring
      if (!result.domain) {
        logger.warn('Missing domain in search result, using extracted domain');
        return score;
      }

      const domain = result.domain.toLowerCase();
      
      // Validate domain format
      if (!/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(domain)) {
        logger.warn('Invalid domain format:', { domain });
        return score;
      }

      // Domain reliability scoring
      if (domain.endsWith('.gov') || domain.endsWith('.edu')) {
        score += 0.3;
      } else if (domain.endsWith('.org')) {
        score += 0.2;
      } else if (domain.endsWith('.com') || domain.endsWith('.net')) {
        // Check for known reliable tech/news/security domains
        const reliableDomains = [
          'reuters.com',
          'bloomberg.com',
          'techcrunch.com',
          'zdnet.com',
          'wired.com',
          'securityweek.com',
          'bleepingcomputer.com',
          'theregister.com',
          'thehackernews.com',
          'krebsonsecurity.com',
          'cyberscoop.com',
          'darkreading.com',
          'threatpost.com',
          'cointelegraph.com',
          'coindesk.com',
          'bitcoin.com',
          'bitcoinmagazine.com',
          'ciphertrace.com',
          'chainalysis.com',
          'elliptic.co'
        ];

        const mediumReliableDomains = [
          'medium.com',
          'github.com',
          'gitlab.com',
          'wikipedia.org',
          'reddit.com'
        ];

        if (reliableDomains.some(d => domain.endsWith(d))) {
          score += 0.25;
        } else if (mediumReliableDomains.some(d => domain.endsWith(d))) {
          score += 0.15;
        }
      }

      // Age-based scoring
      if (result.age) {
        try {
          const ageMatch = result.age.match(/(\d+)\s+(day|month|year)s?\s+ago/i);
          if (ageMatch) {
            const [, amount, unit] = ageMatch;
            const ageInDays = unit.toLowerCase() === 'day' ? parseInt(amount) :
                           unit.toLowerCase() === 'month' ? parseInt(amount) * 30 :
                           parseInt(amount) * 365;
            
            // Newer sources (within last 6 months) get a bonus
            if (ageInDays <= 180) {
              score += 0.1;
            } else if (ageInDays <= 365) {
              score += 0.05;
            }
          }
        } catch (ageError) {
          logger.warn('Error parsing age:', { age: result.age, error: ageError });
        }
      }

      // Description quality scoring
      if (result.description) {
        if (result.description.length > 200) {
          score += 0.15;
        } else if (result.description.length > 100) {
          score += 0.1;
        }
      }

      logger.debug('Calculated reliability score:', {
        domain,
        score,
        age: result.age,
        descriptionLength: result?.description?.length
      });

      return Math.min(1, Math.max(0, score)); // Ensure score is between 0 and 1
    } catch (error) {
      logger.warn('Error calculating reliability score:', {
        error,
        domain: result?.domain,
        fallbackScore: 0.5
      });
      return 0.5; // Return default score on error
    }
  }
} 