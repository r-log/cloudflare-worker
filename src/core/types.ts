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