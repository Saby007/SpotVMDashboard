import { LogLevel, IPublicClientApplication, PublicClientApplication, InteractionType, BrowserCacheLocation } from '@azure/msal-browser';
import { MsalGuardConfiguration, MsalInterceptorConfiguration } from '@azure/msal-angular';

// These constants are baked into the build by Angular's environment plumbing.
// In a future hardening pass we can move them to environment.ts; for now they're inline
// constants since the values are not secret (client_id + tenant are public identifiers).
export const ENTRA_TENANT_ID = '16b3c013-d300-468d-ac64-7eda0820b6d3';
export const ENTRA_APP_CLIENT_ID = '2ba186ae-8d31-4a28-94d2-dbf94c9c2a19';
export const API_SCOPE = `api://${ENTRA_APP_CLIENT_ID}/access_as_user`;

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
  // Attach the API scope token to every same-origin /api/* call.
  map.set('/api/*', [API_SCOPE]);
  return {
    interactionType: InteractionType.Redirect,
    protectedResourceMap: map
  };
}

export function MSALGuardConfigFactory(): MsalGuardConfiguration {
  return {
    interactionType: InteractionType.Redirect,
    authRequest: { scopes: [API_SCOPE] }
  };
}
