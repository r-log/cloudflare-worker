export interface GithubResponse {
  repository?: {
    name: string;
    description: string;
    stars: number;
    forks: number;
  };
  error?: string;
}

// Configuration types
export interface ServiceConfig {
  timeout: number;
  retries: number;
  backoff: {
    initial: number;
    factor: number;
    maxDelay: number;
  };
}

export interface JobStatus {
  id: string;
  status: 'queued' | 'processing' | 'completed' | 'failed';
  prNumber: number;
  repoFullName: string;
  queuePosition: number;
  createdAt: string;
  updatedAt: string;
  result?: string;
}

export interface QueueManager {
  currentJob?: JobStatus;
  queue: JobStatus[];
}

export interface JobResult {
  status: 'success' | 'failure';
  message: string;
  details?: ArticleValidationResult | Record<string, unknown>;
}

export interface ArticleFrontMatter {
  date: string;
  'target-entities': string;
  'entity-types': string[];
  'attack-types': string;
  title: string;
  loss: number;
}

export interface ArticleStructure {
  frontMatter: ArticleFrontMatter;
  sections: {
    summary: string;
    attackers: string;
    losses: string;
    timeline: string;
    securityFailureCauses: string;
  };
}

export interface ArticleValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
  frontMatterValid: boolean;
  sectionsValid: boolean;
  missingRequiredSections: string[];
  additionalSections: string[];
  duplicationCheck?: DuplicationCheckResult;
}

export interface DuplicationCheckResult {
  isDuplicate: boolean;
  existingFilePath?: string;
  comparisonResult?: ComparisonResult;
}

export interface ComparisonResult {
  hasNewInformation: boolean;
  differences?: string[];
  similarityScore?: number;
} 