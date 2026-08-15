// idd-skill#2079 regression fixture: a non-IDD-managed adopter
// application file using {{ token }} as its own runtime template
// syntax (i18n, mustache-style templates, etc.). This must never be
// flagged by idd-doctor's `checkPlaceholders` -- it has nothing to do
// with IDD onboarding import placeholders.
export default {
  greeting: 'Hello, {{ year }}!',
};
