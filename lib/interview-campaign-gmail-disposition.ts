import {ProductionProviderError} from "./interview-production-providers";

export type CampaignGmailDisposition = "uncertain" | "requeue" | "fail";
export type CampaignGmailFailure = {
  code: string;
  errorClass: string;
  httpStatus: number | null;
  disposition: CampaignGmailDisposition;
};

const ERROR_CLASSES = new Set([
  "oauth_refresh", "oauth_config", "identity", "config",
  "gmail_rejected", "gmail_unauthorized", "gmail_forbidden",
  "outcome_uncertain", "timeout", "network", "upstream", "invalid_acceptance",
]);

/** Pre-send and definite Gmail rejections. Never an ambiguous acceptance. */
export const SAFE_CAMPAIGN_RETRY_CODES = [
  "campaign_gmail_oauth_not_configured",
  "campaign_gmail_oauth_refresh_failed",
  "campaign_gmail_oauth_invalid_grant",
  "campaign_gmail_oauth_unauthorized",
  "campaign_gmail_oauth_forbidden",
  "campaign_gmail_credential_missing",
  "campaign_gmail_provider_auth_disabled",
  "campaign_gmail_wrong_account",
  "campaign_gmail_identity_failed",
  "campaign_gmail_identity_rejected",
  "campaign_gmail_rejected",
  "campaign_gmail_unauthorized",
  "campaign_gmail_forbidden",
  "campaign_delivery_invalid",
  "campaign_public_origin_invalid",
  "campaign_sending_not_authorized",
] as const;

const KNOWN_PRE_SEND: Record<string, Omit<CampaignGmailFailure, "httpStatus">> = {
  provider_auth_preview_only: {code:"campaign_gmail_provider_auth_disabled", errorClass:"config", disposition:"fail"},
  provider_not_connected: {code:"campaign_gmail_credential_missing", errorClass:"oauth_config", disposition:"fail"},
  provider_encryption_not_configured: {code:"campaign_gmail_oauth_not_configured", errorClass:"config", disposition:"fail"},
  provider_account_mismatch: {code:"campaign_gmail_wrong_account", errorClass:"identity", disposition:"fail"},
  google_provider_invalid_grant: {code:"campaign_gmail_oauth_invalid_grant", errorClass:"oauth_refresh", disposition:"fail"},
  google_provider_invalid_client: {code:"campaign_gmail_oauth_not_configured", errorClass:"config", disposition:"fail"},
  google_provider_unauthorized_client: {code:"campaign_gmail_oauth_forbidden", errorClass:"oauth_refresh", disposition:"fail"},
  google_provider_access_denied: {code:"campaign_gmail_oauth_forbidden", errorClass:"oauth_refresh", disposition:"fail"},
  provider_token_refresh_failed: {code:"campaign_gmail_oauth_refresh_failed", errorClass:"oauth_refresh", disposition:"requeue"},
  google_provider_authorization_failed: {code:"campaign_gmail_oauth_refresh_failed", errorClass:"oauth_refresh", disposition:"requeue"},
  google_provider_invalid_response: {code:"campaign_gmail_oauth_refresh_failed", errorClass:"oauth_refresh", disposition:"requeue"},
  production_provider_database_invalid: {code:"campaign_gmail_oauth_not_configured", errorClass:"config", disposition:"fail"},
  production_provider_authorization_disabled: {code:"campaign_gmail_provider_auth_disabled", errorClass:"config", disposition:"fail"},
  campaign_delivery_invalid: {code:"campaign_delivery_invalid", errorClass:"config", disposition:"fail"},
  campaign_public_origin_invalid: {code:"campaign_public_origin_invalid", errorClass:"config", disposition:"fail"},
  campaign_sending_not_authorized: {code:"campaign_sending_not_authorized", errorClass:"config", disposition:"fail"},
  interview_production_real_disabled: {code:"campaign_gmail_oauth_not_configured", errorClass:"config", disposition:"fail"},
};

export class CampaignGmailError extends Error {
  readonly errorClass: string;
  readonly httpStatus: number | null;
  readonly disposition: CampaignGmailDisposition;
  constructor(failure: CampaignGmailFailure) {
    super(failure.code);
    this.name = "CampaignGmailError";
    this.errorClass = failure.errorClass;
    this.httpStatus = failure.httpStatus;
    this.disposition = failure.disposition;
  }
}

export function safeCampaignErrorCode(code: string): string {
  return /^[a-z][a-z0-9_]{0,80}$/.test(code) ? code : "campaign_gmail_outcome_uncertain";
}

export function httpStatusOf(error: unknown): number | null {
  if (!error || typeof error !== "object" || !("httpStatus" in error)) return null;
  const status = (error as {httpStatus?: unknown}).httpStatus;
  return typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599
    ? status : null;
}

export function safeCampaignErrorDetail(failure: CampaignGmailFailure): {errorClass: string; httpStatus?: number} {
  const errorClass = ERROR_CLASSES.has(failure.errorClass) ? failure.errorClass : "outcome_uncertain";
  const status = failure.httpStatus;
  if (typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599) {
    return {errorClass, httpStatus: status};
  }
  return {errorClass};
}

function withStatus(failure: Omit<CampaignGmailFailure, "httpStatus">, status: number | null): CampaignGmailFailure {
  if ((status === 400 || status === 401 || status === 403) && failure.disposition === "requeue") {
    return {...failure, httpStatus: status, disposition: "fail"};
  }
  return {...failure, httpStatus: status};
}

function classifyProvider(code: string, status: number | null): CampaignGmailFailure {
  if (code === "production_google_oauth_not_configured") {
    return {code:"campaign_gmail_oauth_not_configured", errorClass:"config", httpStatus: status, disposition:"fail"};
  }
  if (code === "production_google_oauth_invalid") {
    return {code:"campaign_gmail_oauth_refresh_failed", errorClass:"oauth_refresh", httpStatus: status, disposition:"fail"};
  }
  if (code === "production_google_wrong_account") {
    return {code:"campaign_gmail_wrong_account", errorClass:"identity", httpStatus: status, disposition:"fail"};
  }
  if (code === "production_google_identity_unavailable") {
    const definite = status === 400 || status === 401 || status === 403;
    return {
      code: definite ? "campaign_gmail_identity_rejected" : "campaign_gmail_identity_failed",
      errorClass: "identity", httpStatus: status, disposition: definite ? "fail" : "requeue",
    };
  }
  if (status === 400) return {code:"campaign_gmail_oauth_invalid_grant", errorClass:"oauth_refresh", httpStatus: status, disposition:"fail"};
  if (status === 401) return {code:"campaign_gmail_oauth_unauthorized", errorClass:"oauth_refresh", httpStatus: status, disposition:"fail"};
  if (status === 403) return {code:"campaign_gmail_oauth_forbidden", errorClass:"oauth_refresh", httpStatus: status, disposition:"fail"};
  return {code:"campaign_gmail_oauth_refresh_failed", errorClass:"oauth_refresh", httpStatus: status, disposition:"requeue"};
}

/** Failures from token refresh, identity, or configuration. Gmail was not called. */
export function classifyPreSendFailure(error: unknown): CampaignGmailFailure {
  const status = httpStatusOf(error);
  if (error instanceof CampaignGmailError) {
    return {
      code: safeCampaignErrorCode(error.message),
      errorClass: ERROR_CLASSES.has(error.errorClass) ? error.errorClass : "oauth_refresh",
      httpStatus: error.httpStatus ?? status,
      disposition: error.disposition === "uncertain" ? "requeue" : error.disposition,
    };
  }
  if (error instanceof ProductionProviderError) return classifyProvider(error.code, status ?? error.httpStatus);
  if (error instanceof Error && KNOWN_PRE_SEND[error.message]) {
    return withStatus(KNOWN_PRE_SEND[error.message], status);
  }
  return {code:"campaign_gmail_oauth_refresh_failed", errorClass:"oauth_refresh", httpStatus: status, disposition:"requeue"};
}

/** A completed Gmail HTTP response. Only 5xx is ambiguous. */
export function classifyGmailHttpStatus(status: number): CampaignGmailFailure {
  if (status === 400) return {code:"campaign_gmail_rejected", errorClass:"gmail_rejected", httpStatus:400, disposition:"fail"};
  if (status === 401) return {code:"campaign_gmail_unauthorized", errorClass:"gmail_unauthorized", httpStatus:401, disposition:"fail"};
  if (status === 403) return {code:"campaign_gmail_forbidden", errorClass:"gmail_forbidden", httpStatus:403, disposition:"fail"};
  if (status === 429) return {code:"campaign_gmail_rejected", errorClass:"gmail_rejected", httpStatus:429, disposition:"requeue"};
  if (status >= 400 && status < 500) {
    return {code:"campaign_gmail_rejected", errorClass:"gmail_rejected", httpStatus: status, disposition:"fail"};
  }
  return {code:"campaign_gmail_outcome_uncertain", errorClass:"upstream", httpStatus: status, disposition:"uncertain"};
}

/**
 * Unknown errors after dispatch stay uncertain. Known token and config errors do not,
 * because those paths return before Gmail can accept a message.
 */
export function classifyCampaignDeliveryError(error: unknown): CampaignGmailFailure {
  if (error instanceof CampaignGmailError) {
    return {
      code: safeCampaignErrorCode(error.message),
      errorClass: ERROR_CLASSES.has(error.errorClass) ? error.errorClass : "outcome_uncertain",
      httpStatus: httpStatusOf(error),
      disposition: error.disposition,
    };
  }
  if (error instanceof ProductionProviderError || (error instanceof Error && KNOWN_PRE_SEND[error.message])) {
    return classifyPreSendFailure(error);
  }
  return {
    code: "campaign_gmail_outcome_uncertain",
    errorClass: "outcome_uncertain",
    httpStatus: httpStatusOf(error),
    disposition: "uncertain",
  };
}
