// Company settings for this copy of the cash flow app.
// Everything specific to one company lives here (plus the colour block at the top of styles.css
// and the files in assets/), so a copy for another company only changes these.
window.APP_CONFIG = {
  company: 'Cozmo',
  wordmark: 'cozmo',                         // text shown when there is no logo image
  logo: '',                                  // '' = show the wordmark text instead
  badge: '',                                 // round emblem on the password screen and browser tab; '' = none
  repo: 'eriklubbe/cozmo_weekly-cash-flow',  // GitHub repository holding data/cashflow.json
  storageKey: 'cozmo-cashflow',              // prefix for what the browser saves; must differ per company
  creditFacility: 'Credit facility',         // the list on This week for bills paid with a credit facility
  bank: 'Barclays',                          // names the bulk payment file
};
