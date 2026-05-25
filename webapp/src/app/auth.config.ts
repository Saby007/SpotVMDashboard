import { LogLevel, IPublicClientApplication, PublicClientApplication, InteractionType, BrowserCacheLocation } from '@azure/msal-browser';
import { MsalGuardConfiguration, MsalInterceptorConfiguration } from '@azure/msal-angular';

// Public identifiers (not secrets).
export const ENTRA_TENANT_ID = '16b3c013-d300-468d-ac64-7eda0820b6d3';
export const ENTRA_APP_CLIENT_ID = '2ba186ae-8d31-4a28-94d2-dbf94c9c2a19';

// SPA-only architecture: the browser acquires ARM tokens directly via MSAL and calls
// management.azure.com itself. No backend OBO, no custom API scope required. ARM's
// user_impersonation is a user-consentable delegated permission in most tenants, so
// each user can self-consent on first sign-in (when tenant policy allows it).
export const ARM_SCOPE = 'https://management.azure.com/user_impersonation';
export const ARM_DEFAULT_SCOPES = [ARM_SCOPE];

// Back-compat alias for any code still importing API_SCOPE.
export const API_SCOPE = ARM_SCOPE;

export function MSALInstanceFactory(): IPublicClientApplication {
  return new PublicClientApplication({
    auth: {
      clientId: ENTRA_APP_CLIENT_ID,
      authority: `https://login.microsoftonline.com/${ENTRA_TENANT_ID}`,
      redirectUri: window.location.origin + '/',
      postLogoutRedirectUri: window.location.origin + '/'
    },
    cache: {
      cacheLocation: BrowserCacheLocation.LocalStorage
    },
    system: {
      loggerOptions: {
        loggerCallback: (level, message) => {
          if (level === LogLevel.Error) console.error('[MSAL]', message);
        },
        logLevel: LogLevel.Warning,
        piiLoggingEnabled: false
      }
    }
  });
}

export function MSALInterceptorConfigFactory(): MsalInterceptorConfiguration {
  const map = new Map<string, Array<string>>();
  // Auto-attach an ARM access token to every HttpClient call going to management.azure.com.
  map.set('https://management.azure.com/*', ARM_DEFAULT_SCOPES);
  return {
    interactionType: InteractionType.Redirect,
    protectedResourceMap: map
  };
}

export function MSALGuardConfigFactory(): MsalGuardConfiguration {
  return {
    interactionType: InteractionType.Redirect,
    authRequest: { scopes: ARM_DEFAULT_SCOPES }
  };
}
