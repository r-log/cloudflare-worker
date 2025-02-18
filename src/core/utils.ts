import { SignJWT } from 'jose';
import { Env } from '../index';
import * as Sentry from '@sentry/browser';
import { logger } from './logger';


export async function getGitHubAppToken(env: Env, installationId: string): Promise<string> {
  try {
    // First, generate a JWT for the GitHub App
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      iat: now - 60,          // Issued 60 seconds ago
      exp: now + (10 * 60),   // Expires in 10 minutes
      iss: env.GITHUB_APP_ID  // GitHub App's identifier
    };

    // Create and sign the JWT
    const privateKey = env.GITHUB_PRIVATE_KEY.replace(/\\n/g, '\n');
    const jwt = await new SignJWT(payload)
      .setProtectedHeader({ alg: 'RS256' })
      .sign(await importPKCS8(privateKey));

    // Exchange the JWT for an installation access token
    const response = await fetch(
      `https://api.github.com/app/installations/${installationId}/access_tokens`,
      {
        method: 'POST',
        headers: {
          'Accept': 'application/vnd.github.v3+json',
          'Authorization': `Bearer ${jwt}`,
          'User-Agent': 'ArticleChecker-Bot'
        }
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to get installation token: ${response.status} ${response.statusText} - ${errorText}`);
    }

    const data = await response.json() as { token: string };
    return data.token;
  } catch (error) {
    logger.error('Failed to get GitHub App token:', error);
    Sentry.captureException(error, {
      tags: {
        installationId,
        appId: env.GITHUB_APP_ID
      }
    });
    throw error;
  }
}

async function importPKCS8(pem: string): Promise<CryptoKey> {
  try {
    // Convert the PEM string to an ArrayBuffer
    const pemHeader = '-----BEGIN PRIVATE KEY-----';
    const pemFooter = '-----END PRIVATE KEY-----';
    
    // Clean the private key: remove headers, footers, newlines, and spaces
    const pemContents = pem
      .replace(pemHeader, '')
      .replace(pemFooter, '')
      .replace(/\\n/g, '\n')  // Convert literal \n to newlines
      .split('\n')            // Split into lines
      .map(line => line.trim())  // Remove whitespace
      .filter(line => line.length > 0)  // Remove empty lines
      .join('');              // Join back together
    
    const binaryDer = base64ToArrayBuffer(pemContents);

    // Import the key
    return await crypto.subtle.importKey(
      'pkcs8',
      binaryDer,
      {
        name: 'RSASSA-PKCS1-v1_5',
        hash: 'SHA-256',
      },
      false,
      ['sign']
    );
  } catch (error) {
    logger.error('Failed to import private key:', error);
    Sentry.captureException(error, {
      tags: { operation: 'importPKCS8' }
    });
    throw error;
  }
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  try {
    const binary = atob(base64);
    const len = binary.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
  } catch (error) {
    logger.error('Failed to decode base64:', error);
    Sentry.captureException(error, {
      tags: { operation: 'base64ToArrayBuffer' }
    });
    throw error;
  }
}

export async function verifyGitHubWebhook(request: Request, secret: string): Promise<boolean> {
  try {
    const signature = request.headers.get('x-hub-signature-256');
    const body = await request.clone().text();

    if (!signature) {
      logger.warn('No signature found in webhook request');
      return false;
    }

    // Convert secret to key
    const encoder = new TextEncoder();
    const keyData = encoder.encode(secret);
    const key = await crypto.subtle.importKey(
      'raw',
      keyData,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );

    // Calculate expected signature
    const bodyData = encoder.encode(body);
    const signatureData = await crypto.subtle.sign(
      'HMAC',
      key,
      bodyData
    );

    // Convert to hex
    const expectedSignature = 'sha256=' + Array.from(new Uint8Array(signatureData))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');

    const isValid = signature === expectedSignature;
    if (!isValid) {
      logger.warn('Invalid webhook signature');
      Sentry.addBreadcrumb({
        category: 'webhook',
        message: 'Invalid webhook signature detected',
        level: 'warning'
      });
    }

    return isValid;
  } catch (error) {
    logger.error('Failed to verify webhook signature:', error);
    Sentry.captureException(error, {
      tags: { operation: 'verifyGitHubWebhook' }
    });
    throw error;
  }
}

export interface PullRequestFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  blob_url: string;
  raw_url: string;
  contents_url: string;
  patch: string;
}

export async function fetchPRFiles(
  repoFullName: string,
  prNumber: number,
  token: string
): Promise<PullRequestFile[]> {
  try {
    const response = await fetch(
      `https://api.github.com/repos/${repoFullName}/pulls/${prNumber}/files`,
      {
        headers: {
          'Accept': 'application/vnd.github.v3+json',
          'Authorization': `Bearer ${token}`,
          'User-Agent': 'ArticleChecker-Bot'
        }
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to fetch PR files: ${response.status} ${response.statusText} - ${errorText}`);
    }

    return await response.json() as PullRequestFile[];
  } catch (error) {
    logger.error('Failed to fetch PR files:', error);
    Sentry.captureException(error, {
      tags: {
        repoFullName,
        prNumber: prNumber.toString()
      }
    });
    throw error;
  }
}

export async function fetchFileContent(url: string, token: string): Promise<string> {
  try {
    const response = await fetch(url, {
      headers: {
        'Accept': 'application/vnd.github.v3.raw',
        'Authorization': `Bearer ${token}`,
        'User-Agent': 'ArticleChecker-Bot'
      }
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to fetch file content: ${response.status} ${response.statusText} - ${errorText}`);
    }

    return await response.text();
  } catch (error) {
    logger.error('Failed to fetch file content:', error);
    Sentry.captureException(error, {
      tags: { url }
    });
    throw error;
  }
}

export function findMarkdownFiles(files: PullRequestFile[]): PullRequestFile[] {
  return files.filter(file => 
    file.filename.endsWith('.md') && 
    (file.status === 'added' || file.status === 'modified')
  );
}

