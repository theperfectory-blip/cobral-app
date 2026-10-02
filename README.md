# Cobral

App de ventas, inventario y deudas para un comerciante en terreno. Funciona **sin internet y sin cuenta** en el
teléfono (Android), y con una cuenta sincroniza con una **versión web** pensada para el computador.

| | |
|---|---|
| **Web** | https://cobral.web.app |
| **Descargar la APK** | https://cobral.web.app/descargar/ (el archivo sale de las [Releases](https://github.com/theperfectory-blip/cobral-app/releases/latest) de este repo) |
| **Versión actual** | 6.1 (`versionCode 61`) |

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
| `node tools/deskshot.mjs <url> <prefijo>` | capturas de la web a varios anchos, claro y oscuro |

## Publicar

Mismo modelo que `tsc-web`: **Firebase solo aloja la web; la APK vive en este repo** (GitHub Release).

**APK** (cada versión):
1. Subir la versión en `android/app/build.gradle` (`versionCode`/`versionName`), el `<title>` de `www/index.html`
   y el nombre de caché de `www/sw.js`.
2. Compilar con `bash tools/build.sh` y copiar `android/app/build/outputs/apk/debug/app-debug.apk` como
   `../Cobral_v<versión>.apk`.
3. Crear la Release con **dos copias** del archivo: la versionada y la de nombre fijo `Cobral.apk`, que es la que
   enlaza la web (`.../releases/latest/download/Cobral.apk`, apunta siempre a la última):

```bash
cp ../Cobral_v6.1.apk /tmp/Cobral.apk
gh release create v6.1 ../Cobral_v6.1.apk /tmp/Cobral.apk --title "Cobral v6.1" --notes "..."
```

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
