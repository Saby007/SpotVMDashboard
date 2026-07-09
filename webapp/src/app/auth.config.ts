// Local-dev detection (cosmetic only).
//
// This app has no user login. All Azure calls run on the Node host:
//   • On localhost the host uses your local Azure CLI session (`az login`).
//   • In Azure App Service the host uses the site's managed identity.
//
// DEV_MODE is only used to show a small "LOCAL DEV" vs "APP SERVICE IDENTITY"
// badge in the header — it does not gate any functionality.
export const DEV_MODE: boolean = typeof window !== 'undefined'
  && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');
