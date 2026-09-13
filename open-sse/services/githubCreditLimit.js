import { getGitHubUsage } from "./usage/github.js";
import { HTTP_STATUS } from "../config/runtimeConfig.js";

export function isValidGitHubCreditLimit(limit) {
  return limit === null || (typeof limit === "number" && Number.isFinite(limit) && limit >= 0);
}

export async function checkGitHubCreditLimit(credentials, proxyOptions = null) {
  const limit = credentials?.providerSpecificData?.aiCreditLimit;
  if (limit === undefined || limit === null) return null;
  if (!isValidGitHubCreditLimit(limit)) {
    return { status: HTTP_STATUS.SERVICE_UNAVAILABLE, message: "Invalid Copilot AI Credits limit. Update the connection settings before retrying." };
  }
  if (limit === 0) {
    return { status: HTTP_STATUS.RATE_LIMITED, message: "Copilot AI Credits limit is zero. Requests are blocked by the local credit limit." };
  }
  try {
    const usage = await getGitHubUsage(credentials.accessToken, credentials.providerSpecificData, proxyOptions);
    const used = usage.quotas?.premium_interactions?.creditsUsed;
    if (typeof used !== "number" || !Number.isFinite(used) || used < 0) {
      return { status: HTTP_STATUS.SERVICE_UNAVAILABLE, message: "Cannot verify Copilot AI Credits usage. Request blocked to protect the configured credit limit." };
    }
    if (used >= limit) {
      return { status: HTTP_STATUS.RATE_LIMITED, message: `Copilot AI Credits limit reached (${used} / ${limit}). Wait for GitHub usage to reset or change the connection limit.` };
    }
    return null;
  } catch {
    return { status: HTTP_STATUS.SERVICE_UNAVAILABLE, message: "Cannot fetch Copilot AI Credits usage. Request blocked to protect the configured credit limit." };
  }
}
