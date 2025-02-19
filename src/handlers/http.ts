import { Env } from '../index';
import { logger } from '../core/logger';
import { getGitHubAppToken, verifyGitHubWebhook } from '../core/utils';
import { ArticleCheckQueue, performArticleCheck } from '../core/queue';

// Create a single instance of the queue manager
const queueManager = new ArticleCheckQueue();

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
          return new Response(JSON.stringify({
            error: 'Method not allowed',
            method: request.method
          }), { 
            status: 405,
            headers: { 'Content-Type': 'application/json' }
          });
        }

        // Clone request before reading body
        const clonedRequest = request.clone();
        const rawBody = await clonedRequest.text();
        const payload = JSON.parse(rawBody);

        // Verify webhook signature
        const isValid = await verifyGitHubWebhook(request, env.GITHUB_WEBHOOK_SECRET);
        if (!isValid) {
          return new Response(JSON.stringify({
            error: 'Invalid signature',
            event: request.headers.get('x-github-event'),
            delivery: request.headers.get('x-github-delivery')
          }), { 
            status: 401,
            headers: { 'Content-Type': 'application/json' }
          });
        }

        // Check if this is an issue_comment event
        if (payload.action === 'created' && payload.comment && payload.issue?.pull_request) {
          const commentBody = payload.comment.body.trim();
          
          if (commentBody.startsWith('/articlecheck')) {
            if (!payload.installation?.id) {
              return new Response(JSON.stringify({
                error: 'No installation ID found',
                action: payload.action,
                hasComment: !!payload.comment,
                isPR: !!payload.issue?.pull_request
              }), { 
                status: 400,
                headers: { 'Content-Type': 'application/json' }
              });
            }

            try {
              // Get installation token
              const token = await getGitHubAppToken(env, payload.installation.id);
              
              // Add job to queue (now using in-memory queue)
              const job = await queueManager.addJob(
                payload.issue.number,
                payload.repository.full_name
              );

              // Post initial status comment
              let statusMessage = `### 🤖 ArticleChecker Bot - Analysis Request Received\n\n`;
              
              if (job.status === 'processing') {
                statusMessage += `#### Status: 🔍 Analysis In Progress\n\n` +
                  `I'm now analyzing your article for quality and compliance with our guidelines.\n\n` +
                  `**Details:**\n` +
                  `- **PR:** #${job.prNumber}\n` +
                  `- **Repository:** ${job.repoFullName}\n` +
                  `- **Job ID:** \`${job.id}\`\n` +
                  `- **Started At:** ${new Date().toLocaleString()}\n\n` +
                  `I'll post the results here as soon as the analysis is complete. This usually takes about 30 seconds.`;
              } else {
                statusMessage += `#### Status: ⏳ Queued\n\n` +
                  `Your article check request has been queued. I'll start the analysis as soon as possible.\n\n` +
                  `**Details:**\n` +
                  `- **PR:** #${job.prNumber}\n` +
                  `- **Repository:** ${job.repoFullName}\n` +
                  `- **Job ID:** \`${job.id}\`\n` +
                  `- **Queue Position:** ${job.queuePosition + 1}\n` +
                  `- **Queued At:** ${new Date().toLocaleString()}\n\n` +
                  `I'll notify you when your analysis begins. Thank you for your patience!`;
              }

              await postGitHubComment(
                payload.repository.full_name,
                payload.issue.number,
                statusMessage,
                token
              );

              // If this is the current job, process it
              if (job.status === 'processing') {
                // Perform article check
                const result = await performArticleCheck(
                  payload.issue.number,
                  payload.repository.full_name,
                  token,
                  env.OPENROUTER_API_KEY
                );
                
                // Complete the job
                await queueManager.completeJob(job.id, result);

                // Post completion comment
                await postGitHubComment(
                  payload.repository.full_name,
                  payload.issue.number,
                  `### 🤖 ArticleChecker Bot - Analysis Complete\n\n` +
                  `#### Status: ${result.status === 'success' ? '✅ Success' : '❌ Failed'}\n\n` +
                  `${result.message}\n\n` +
                  `**Analysis Details:**\n` +
                  `- **PR:** #${job.prNumber}\n` +
                  `- **Repository:** ${job.repoFullName}\n` +
                  `- **Job ID:** \`${job.id}\`\n\n` +
                  `---\n` +
                  `*Need another check? Just comment \`/articlecheck\` again!*`,
                  token
                );
              }
              
              return new Response(JSON.stringify({
                status: 'success',
                action: 'job_created',
                jobId: job.id,
                jobStatus: job.status,
                queuePosition: job.queuePosition
              }), { 
                status: 200,
                headers: { 'Content-Type': 'application/json' }
              });
            } catch (error) {
              return new Response(JSON.stringify({
                error: 'Failed to process command',
                details: error instanceof Error ? error.message : 'Unknown error',
                repo: payload.repository?.full_name,
                pr: payload.issue?.number
              }), { 
                status: 500,
                headers: { 'Content-Type': 'application/json' }
              });
            }
          }
        }
        
        return new Response(JSON.stringify({
          status: 'ignored',
          event: request.headers.get('x-github-event'),
          action: payload.action,
          hasComment: !!payload.comment,
          isPR: !!payload.issue?.pull_request,
          commentBody: payload.comment?.body
        }), { 
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });

      default:
        return new Response('Not Found', { status: 404 });
    }
  } catch (error) {
    return new Response(JSON.stringify({
      error: 'Internal server error',
      details: error instanceof Error ? error.message : 'Unknown error'
    }), { 
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
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
      'User-Agent': 'ArticleChecker-Bot'
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