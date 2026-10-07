export interface AuthStatus {
  mode: 'app_only';
  signedIn: boolean;
  account: string | null;
  expiresAt: string | null;
}

export interface DeviceCodeInfo {
  userCode: string;
  verificationUri: string;
  message: string;
  expiresIn: number;
}

export type LoginPollState = 'idle' | 'pending' | 'success' | 'error' | 'expired';

export interface LoginPollStatus {
  state: LoginPollState;
  error?: string;
}

/** Minimal auth surface used by the SharePoint/Graph client. */
export interface EntraAuth {
  getAccessToken(scope: string): Promise<string>;
  status(): AuthStatus;
  startLogin(): Promise<DeviceCodeInfo>;
  pollLogin(): LoginPollStatus;
  logout(): Promise<void>;
}
