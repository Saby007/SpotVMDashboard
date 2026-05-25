import { LogLevel, IPublicClientApplication, PublicClientApplication, InteractionType, BrowserCacheLocation } from '@azure/msal-browser';
import { MsalGuardConfiguration, MsalInterceptorConfiguration } from '@azure/msal-angular';

// Public identifiers (not secrets).
// Personal Microsoft tenant — used for testing because MS-corp policy blocks
// user consent for third-party apps. The architecture is identical for HDFC's tenant;
// only these two IDs need to change.
export const ENTRA_TENANT_ID = '780a4ea6-63fc-43dd-8d57-764f0db161ed';
export const ENTRA_APP_CLIENT_ID = '5ce73c51-046b-492d-89c6-66517b817e63';

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
