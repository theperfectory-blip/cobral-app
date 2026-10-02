// Firebase web config for project cobral-app (public identifiers, not secrets — access is enforced by firebase/firestore.rules).
window.COBRAL_FIREBASE_CONFIG = {
  apiKey: 'AIzaSyD8LxeFQTkFY1Ofj4c48kGXcZUudiLg6Uw',
  authDomain: 'cobral-app.firebaseapp.com',
  projectId: 'cobral-app',
  storageBucket: 'cobral-app.firebasestorage.app',
  messagingSenderId: '60325446787',
  appId: '1:60325446787:web:292ff3035908f69c2f07b6',
};

// Cloudinary (fotos de productos). Misma cuenta que tsc-web; preset "cobral_fotos" en modo Unsigned (sin firmar).
// cloudName y uploadPreset son publicos por diseno: el secreto de la cuenta nunca va en la app.
window.COBRAL_CLOUDINARY = { cloudName: 'dnjijd8mx', uploadPreset: 'cobral_fotos' };
