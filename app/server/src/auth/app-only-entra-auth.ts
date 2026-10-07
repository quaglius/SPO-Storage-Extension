import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ClientCertificateCredential,
  ClientSecretCredential,
  type TokenCredential,
} from '@azure/identity';
import type { AuthStatus, DeviceCodeInfo, EntraAuth, LoginPollStatus } from './types.js';

export type AppOnlyEnv =
  | {
      kind: 'certificate';
      tenantId: string;
      clientId: string;
      certificatePath: string;
    }
  | {
      kind: 'secret';
      tenantId: string;
      clientId: string;
      clientSecret: string;
    };

/**
 * App-only auth for cloud workers.
 * SharePoint REST requires a **certificate** (client secret → "Unsupported app only token").
 * Prefer PEM (private key + cert) via SPOSTORAGE_APP_ONLY_CERT_PEM_BASE64 or CERT_PATH.
 */
export class AppOnlyEntraAuth implements EntraAuth {
  private readonly credential: TokenCredential;
  private readonly accountLabel: string;

  constructor(opts: AppOnlyEnv) {
    this.accountLabel = `app:${opts.clientId} (${opts.kind})`;
    if (opts.kind === 'certificate') {
      this.credential = new ClientCertificateCredential(
        opts.tenantId,
        opts.clientId,
        opts.certificatePath,
        { sendCertificateChain: true },
      );
    } else {
      this.credential = new ClientSecretCredential(opts.tenantId, opts.clientId, opts.clientSecret);
    }
  }

  async getAccessToken(scope: string): Promise<string> {
    const appScope = scope.endsWith('/.default')
      ? scope
      : scope.includes('://')
        ? `${scope.replace(/\/$/, '')}/.default`
        : scope;
    const token = await this.credential.getToken(appScope);
    if (!token?.token) {
      throw new Error('Could not obtain app-only token');
    }
    return token.token;
  }

  status(): AuthStatus {
    return {
      mode: 'app_only',
      signedIn: true,
      account: this.accountLabel,
      expiresAt: null,
    };
  }

  async startLogin(): Promise<DeviceCodeInfo> {
    throw new Error('App-only mode does not use interactive sign-in');
  }

  pollLogin(): LoginPollStatus {
    return { state: 'idle' };
  }

  async logout(): Promise<void> {
    /* stateless */
  }
}

let cachedPemPath: string | null = null;

function materializeCertFromEnv(): string | null {
  const explicitPath = process.env.SPOSTORAGE_APP_ONLY_CERT_PATH?.trim();
  if (explicitPath && fs.existsSync(explicitPath)) {
    return explicitPath;
  }

  const pemB64 = process.env.SPOSTORAGE_APP_ONLY_CERT_PEM_BASE64?.trim();
  if (pemB64) {
    if (!cachedPemPath || !fs.existsSync(cachedPemPath)) {
      const dir = path.join(os.tmpdir(), 'spostorage-app-only');
      fs.mkdirSync(dir, { recursive: true });
      cachedPemPath = path.join(dir, 'client.pem');
      fs.writeFileSync(cachedPemPath, Buffer.from(pemB64, 'base64'));
    }
    return cachedPemPath;
  }

  return null;
}

export function readAppOnlyEnv(): AppOnlyEnv | null {
  const tenantId =
    process.env.SPOSTORAGE_APP_ONLY_TENANT_ID?.trim() ||
    process.env.AZURE_TENANT_ID?.trim() ||
    '';
  const clientId =
    process.env.SPOSTORAGE_APP_ONLY_CLIENT_ID?.trim() ||
    process.env.AZURE_CLIENT_ID?.trim() ||
    '';
  if (!tenantId || !clientId) return null;

  const certPath = materializeCertFromEnv();
  if (certPath) {
    return { kind: 'certificate', tenantId, clientId, certificatePath: certPath };
  }

  const clientSecret =
    process.env.SPOSTORAGE_APP_ONLY_CLIENT_SECRET?.trim() ||
    process.env.AZURE_CLIENT_SECRET?.trim() ||
    '';
  if (!clientSecret) return null;
  return { kind: 'secret', tenantId, clientId, clientSecret };
}
