# Cobral

App de ventas, inventario y deudas para un comerciante en terreno. Funciona **sin internet y sin cuenta** en el
teléfono (Android), y con una cuenta sincroniza con una **versión web** pensada para el computador.

| | |
|---|---|
| **Web** | https://cobral.web.app |
| **Descargar la APK** | https://cobral.web.app/descargar/ (el archivo sale de las [Releases](https://github.com/theperfectory-blip/cobral-app/releases/latest) de este repo) |
| **Versión actual** | 6.7 (`versionCode 67`) |

## Qué hace

- **Nueva venta**: tarjetas de producto con mitades táctiles (izquierda resta, derecha suma), carrito que se
  minimiza y maximiza con gestos, medios de pago con comisión (débito/crédito, IVA incluido), ofertas por cantidad y
  precios por ubicación (cada feria puede tener su precio).
- **Inicio / Top ventas**: ingresos, costo, margen y ranking de productos por día, semana, mes o año, con "Hoy" fijo
  y calendario que parte en lunes; al tocar un producto se ven sus ventas.
- **Ventas**: historial con búsqueda (los totales se actualizan al buscar un ticket), edición y eliminación.
- **Inventario**: stock, costo, precio y margen; el precio se calcula en vivo desde el margen deseado (sobre la
  venta, redondeado a $100).
- **Deudas**: deudores, abonos, historial.
- **Fotos de productos** en Cloudinary: se guardan en el teléfono (funcionan sin internet) y, con cuenta, se respaldan
  y se comparten con la web y otros dispositivos.
- **Sincronización** (opcional): correo + contraseña (Firebase Auth) y Firestore. El stock se sincroniza como
  incrementos, así que dos dispositivos que venden el mismo producto a la vez no se pisan.
- **Diseño de escritorio** (solo web, pantallas ≥ 1100 px): barra lateral, tablas ordenables, gráfico clicable,
  venta en dos paneles, exportar la vista a CSV y atajos de teclado (`N`, `/`, `Esc`, `Enter`, `?`).

## Cómo está hecho

- **Un solo archivo**: [`www/index.html`](www/index.html) (JS sin framework). La misma página es la web y lo que
  empaqueta la APK con [Capacitor 8](https://capacitorjs.com) (`cl.cobral.ventas`).
- **Módulo de nube** ([`cloud-src/`](cloud-src)): `cobral-cloud.js` + `sync-core.js`, compilado con esbuild a
  `www/cloud/cobral-cloud.js` (expone `window.CobralCloud`, se carga bajo demanda). Guarda una "sombra" de lo ya
  subido para enviar solo diferencias, mezcla el stock en tres vías y marca lo pendiente para que una edición local
  no se pierda frente a un cambio remoto.
- **Fotos** (`www/index.html`, bloque "FOTOS EN LA NUBE"): cada foto vive en IndexedDB del dispositivo y, con cuenta y
  conexión, se sube a **Cloudinary** (mismo modelo que `tsc-web`: preset *unsigned*, sin secretos en la app). El producto
  guarda el enlace en `imageUrl` y viaja con la sincronización normal; Firestore nunca guarda la imagen y no se usa
  Firebase Storage. `imageUrl` ausente = aún sin subir, `''` = foto eliminada a propósito (se propaga a los otros
  dispositivos), `https://…` = foto en la nube. Un proceso en segundo plano (`reconcilePhotos`) sube lo pendiente
  (incluye las fotos que ya tenía el teléfono antes de crear la cuenta) y baja lo que subieron otros dispositivos.
  Configuración pública en [`www/cloud/config.js`](www/cloud/config.js) (`cloudName` y `uploadPreset`).
- **Firebase** (proyecto `cobral-app`): Auth con correo y contraseña, Firestore `(default)` en
  `southamerica-west1` con protección contra borrado, reglas por usuario (`users/{uid}/**`,
  [`firebase/firestore.rules`](firebase/firestore.rules)) y Hosting (sitio `cobral`, target `web`).
- **Modo escritorio**: `isDesk()` = web (no APK) con ancho ≥ 1100 px. Todo el CSS va bajo `body.desk`; en celular, tablet
  y APK la interfaz es la misma de siempre.

```
www/            la app (index.html) + cloud/ + sw.js (service worker, solo web)
cloud-src/      fuente del módulo de sincronización y sus tests
android/        proyecto Android (Capacitor)
site/descargar/ plantilla de la página de descarga de la APK
firebase/       reglas e índices de Firestore
tools/          verificación, build, emuladores y pruebas de regresión
COBRAL_SLICES.md  historial y especificación de cada cambio (fuente de verdad)
```

## Cloudinary (fotos)

Cuenta de Cloudinary compartida con `tsc-web` (`cloudName` `dnjijd8mx`). Cobral usa su **propio preset de subida**
`cobral_fotos`, que hay que crear una vez en el panel de Cloudinary: *Settings → Upload → Upload presets → Add upload
preset* con **Signing mode: Unsigned**, **Folder: `cobral`** y, recomendado, formatos permitidos `jpg, png, webp` y
tamaño máximo pequeño. Si el preset no existe, la app sigue funcionando: las fotos quedan en el teléfono y en
*Configuración → Cuenta* aparece "Respaldo de fotos no disponible por ahora".

## Desarrollo

Requisitos: Node.js, JDK 21, Android SDK (variable `ANDROID_HOME`) y, para las pruebas de sincronización, Firebase CLI
con Java (emuladores). En esta máquina el SDK está en `D:\AndroidData\Sdk`.

```bash
npm install
node tools/check.mjs            # integridad de www/index.html (correr tras cada edición)
npm run build:cloud             # recompila www/cloud/cobral-cloud.js desde cloud-src/
npm run test:cloud              # tests unitarios del módulo de sincronización
bash tools/build.sh             # APK debug → instala y abre en el emulador/dispositivo conectado
```

Para ver la web en el navegador basta servir `www/` con cualquier servidor estático.

### Pruebas

Todas usan **solo emuladores locales** (Firebase Auth/Firestore en `127.0.0.1` y el emulador de Android), con
cuentas desechables `@cobral.test`. No las corras contra el teléfono real ni contra el proyecto de producción.

| Comando | Qué cubre |
|---|---|
| `bash tools/emulators.sh` | levanta los emuladores de Firebase (dejar corriendo) |
| `node tools/regress.mjs` | 18 comprobaciones funcionales de la APK, sin cuenta (borra los datos de la app) |
| `node tools/regress-sync.mjs` | 5 comprobaciones de sincronización con un segundo "dispositivo" |
| `bash tools/race.sh <correo> <clave>` | 5 carreras: edición de precio en el teléfono mientras otro dispositivo vende lo mismo |
| `npm run e2e:cloud` | 26 pasos del módulo de nube contra los emuladores |
| `node tools/web-e2e.mjs` | la web de escritorio de punta a punta (Edge sin interfaz) |
| `node tools/fake-cloudinary.mjs` | Cloudinary falso local para las pruebas de fotos (dejar corriendo) |
| `node tools/photos-web-e2e.mjs` | fotos entre dos navegadores: subir, bajar, reemplazar, borrar, servicio caído y sin conexión (requiere servidor estático de `www/` en `localhost:5173`) |
| `node tools/regress-photos.mjs` | fotos en el emulador de Android, incluida la subida de las fotos que ya tenía el teléfono |
| `bash tools/build-variant.sh <out.apk> <código> <nombre>` + `node tools/updater-test.mjs <vieja.apk> <código> <nombre> <urlGitHub> <sha256>` | prueba del actualizador en el emulador: aviso, permiso, descarga real desde GitHub, verificación SHA-256, instalador de Android y datos intactos |
| `node tools/restore-backup.mjs <respaldo.json> --yes` | restaura un respaldo (formato `cobral-respaldo-1`: localStorage + fotos de IndexedDB) en la app depurable conectada; solo escribe en emuladores salvo `--allow-device` |
| `bash tools/build-old.sh <out.apk>` + `node tools/upgrade-test.mjs <vieja.apk> ../Cobral_v<nueva>.apk` | prueba de actualización: instala una versión antigua con datos y fotos, instala la nueva encima y verifica que no se perdió nada; también comprueba que Android rechaza una APK con otra firma sin tocar los datos |
| `node tools/deskshot.mjs <url> <prefijo>` | capturas de la web a varios anchos, claro y oscuro |

## Publicar

Mismo modelo que `tsc-web`: **Firebase solo aloja la web; la APK vive en este repo** (GitHub Release).

**APK** (cada versión), con actualizador integrado:
1. Subir la versión en `android/app/build.gradle` (`versionCode` siempre **mayor**, `versionName`), el `<title>` de
   `www/index.html` (`Cobral vX.Y`) y el nombre de caché de `www/sw.js`; commit y `git push`.
2. Compilar con `bash tools/build.sh` y copiar `android/app/build/outputs/apk/debug/app-debug.apk` como
   `../Cobral_v<versión>.apk`. **Siempre con la misma llave de firma** (`~/.android/debug.keystore`); con otra llave
   las apps ya instaladas no podrían actualizarse.
3. Escribir las novedades en un archivo de texto (se muestran tal cual en el aviso de la app) y publicar:

```bash
bash tools/release.sh notas.txt
```

`tools/release.sh` se niega a publicar si el árbol de git no está limpio y subido, si el título/versión no coinciden o si la
APK está firmada con otra llave. Crea la Release con 3 archivos: `Cobral_v<versión>.apk`, `Cobral.apk` (nombre fijo que enlaza
la web) y `update.json` (`versionCode`, `versionName`, `apkUrl`, `sha256`, `notes`).

**Actualizador (solo APK):** al abrir la app (máx. cada 6 h) y desde *Configuración → Buscar actualización*, la app lee
`releases/latest/download/update.json`, compara `versionCode` y, si hay una mayor, muestra las novedades con *Actualizar / Más
tarde*. Descarga la APK desde GitHub (el plugin `AppUpdater` solo acepta `https://github.com/…`), verifica el SHA-256 y abre el
instalador de Android; se instala encima y los datos se conservan. La primera vez Android pide activar *Permitir desde esta
fuente*. Código: `android/app/src/main/java/cl/cobral/ventas/AppUpdaterPlugin.java` y el bloque ACTUALIZADOR de `www/index.html`.

**Web y página de descarga** (Firebase Hosting sirve `dist-web/`, no `www/` directamente):

```bash
node tools/build-site.mjs        # arma dist-web/ = www/ + descargar/ (con tamaño, fecha y SHA-256 de la APK)
firebase deploy --only hosting:web
```

La APK no va dentro del sitio (el plan gratuito de Hosting rechaza `.apk`) ni dentro de `www/` (Capacitor copia esa
carpeta al interior de la APK). La página `/descargar/` solo enlaza a la Release.

## Convenciones

- Los archivos de texto se guardan con **LF** (`.gitattributes`). Al editar desde scripts en Windows no
  reescribir con CRLF.
- Funciones compactas y estilo del archivo existente; cambios quirúrgicos, sin reformatear.
- Idioma de la interfaz: español de Chile.
- La clave de `www/cloud/config.js` es la clave web pública de Firebase; el acceso a los datos lo controlan las
  reglas de Firestore, no esa clave.

## Más detalle

- [`COBRAL_SLICES.md`](COBRAL_SLICES.md): cada cambio, sus decisiones y los errores encontrados.
- [`INSTRUCCIONES.md`](INSTRUCCIONES.md): guía original para generar la APK desde cero (anterior a la versión con nube).
