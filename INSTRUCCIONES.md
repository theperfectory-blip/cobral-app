# Cobral - Guía para generar APK

## Requisitos previos
- ✅ Node.js v25.7.0
- ✅ npm 11.10.1  
- ⬜ Android Studio (descargar de https://developer.android.com/studio)

## Paso 1: Copiar esta carpeta a tu PC

Copia toda la carpeta `cobral-app` a tu disco, por ejemplo:
```
D:\ANDROID APPS\cobral-app\
```

## Paso 2: Abrir PowerShell en la carpeta del proyecto

Abre PowerShell y navega a la carpeta:
```powershell
cd "D:\ANDROID APPS\cobral-app"
```

## Paso 3: Instalar dependencias de Capacitor

```powershell
npm install @capacitor/core @capacitor/cli @capacitor/android
```

## Paso 4: Inicializar Capacitor (si pide algo, dale Enter para aceptar defaults)

```powershell
npx cap init Cobral cl.cobral.ventas --web-dir www
```

Si dice que ya existe capacitor.config.json, escribe "y" para sobreescribir,
o sáltate este paso porque ya lo creamos.

## Paso 5: Agregar plataforma Android

```powershell
npx cap add android
```

Esto crea la carpeta `android/` con el proyecto Android completo.

## Paso 6: Sincronizar archivos web

```powershell
npx cap sync android
```

Esto copia tu app (www/) al proyecto Android.

## Paso 7: Abrir en Android Studio

```powershell
npx cap open android
```

Se abrirá Android Studio con el proyecto. Espera a que termine de sincronizar
Gradle (barra de progreso abajo, puede tardar unos minutos la primera vez).

## Paso 8: Generar la APK

En Android Studio:
1. Menú: **Build → Build Bundle(s) / APK(s) → Build APK(s)**
2. Espera a que compile (~1-2 min)
3. Aparecerá notificación "Build APK(s)" con link "locate"
4. La APK estará en: `android/app/build/outputs/apk/debug/app-debug.apk`

## Paso 9: Instalar en tu celular

Opción A - Cable USB:
1. Copia `app-debug.apk` al celular
2. Abre el archivo desde el celular
3. Permite "instalar de fuentes desconocidas" si lo pide

Opción B - Desde Android Studio:
1. Conecta el celular por USB
2. Activa "Depuración USB" en opciones de desarrollador del celular
3. Click en el botón ▶ (Run) en Android Studio

## Actualizar la app después

Cuando modifiques el HTML:
1. Reemplaza el archivo `www/index.html` con la nueva versión
2. Ejecuta: `npx cap sync android`
3. Vuelve a generar la APK desde Android Studio

## Estructura de archivos
```
cobral-app/
├── package.json              ← Configuración npm
├── capacitor.config.json     ← Configuración Capacitor
├── INSTRUCCIONES.md          ← Este archivo
└── www/                      ← Tu app web
    ├── index.html            ← Cobral v5.2
    └── sw.js                 ← Service Worker
```
