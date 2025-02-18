import { Env } from '../index';
import { logger } from '../core/logger';

export async function handleHttpRequest(
  request: Request,
  env: Env,
  _ctx: ExecutionContext
): Promise<Response> {
  const url = new URL(request.url);

  try {
    switch (url.pathname) {
      case '/api/health':
        return new Response(JSON.stringify({ status: 'ok' }), {
          headers: { 'Content-Type': 'application/json' },
        });

      case '/api/github/webhook':
        if (request.method !== 'POST') {
          return new Response('Method Not Allowed', { status: 405 });
        }

        const payload = await request.json() as {
          action: string;
          comment?: { body: string };
          pull_request: { number: number };
          repository: { full_name: string };
        };
        
        // Check if this is a PR comment event
        if (payload.action === 'created' && payload.comment?.body) {
          const commentBody = payload.comment.body.trim();
          
          if (commentBody.startsWith('/articlecheck')) {
            // Extract PR details
            const prNumber = payload.pull_request.number;
            const repoFullName = payload.repository.full_name;
            
            // Post response comment using GitHub API
            await postGitHubComment(
              repoFullName,
              prNumber,
              "👋 ArticleChecker Bot here! I've received your request and I'm analyzing your article now. I'll post my findings shortly! 🔍",
              env.GITHUB_APP_TOKEN
            );
            
            return new Response('Webhook processed', { status: 200 });
          }
        }
        
        return new Response('Webhook received', { status: 200 });

      default:
        return new Response('Not Found', { status: 404 });
    }
  } catch (error) {
    logger.error('Error handling HTTP request:', error);
    return new Response('Internal Server Error', { status: 500 });
  }
}

async function postGitHubComment(
  repoFullName: string,
  prNumber: number,
  message: string,
  githubToken: string
): Promise<void> {
  const url = `https://api.github.com/repos/${repoFullName}/issues/${prNumber}/comments`;
  
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${githubToken}`,
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
      'User-Agent': 'ArticleChecker-Bot'  // Adding User-Agent as required by GitHub API
    },
    body: JSON.stringify({ body: message }),
  });

  if (!response.ok) {
    const errorData = await response.text();
    logger.error('Failed to post GitHub comment:', {
      status: response.status,
      statusText: response.statusText,
      error: errorData
    });
    throw new Error(`Failed to post GitHub comment: ${response.status} ${response.statusText}`);
  }
} 