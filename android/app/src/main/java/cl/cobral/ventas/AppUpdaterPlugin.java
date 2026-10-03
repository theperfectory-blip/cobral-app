package cl.cobral.ventas;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.util.Log;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;

/**
 * Auto-actualizador de Cobral (mismo modelo que la app de TSC): consulta/pide el permiso de "instalar apps
 * desconocidas", descarga el APK nuevo desde GitHub Releases, verifica su SHA-256 (si el manifiesto lo trae) y abre el
 * instalador de Android. El chequeo de version y la UI viven en JS (index.html, bloque ACTUALIZADOR).
 *
 * La descarga la hace este plugin con HttpURLConnection (hilo propio, reintentos, timeouts cortos, progreso al JS) y NO
 * con DownloadManager: DownloadManager se queda en PAUSED/WAITING_TO_RETRY indefinidamente aunque el archivo ya este
 * completo (visto en emulador, y documentado en el updater de TSC), dejando la UI en "Descargando…" para siempre.
 *
 * Seguridad: la URL solo puede ser https://github.com/... (canal de distribucion real) y Android solo instala el APK si
 * esta firmado con la MISMA llave que la app instalada, asi que un APK ajeno nunca se instalaria encima.
 */
@CapacitorPlugin(name = "AppUpdater")
public class AppUpdaterPlugin extends Plugin {
    private static final String TAG = "AppUpdaterPlugin";
    private static final String ALLOWED_HOST = "github.com";
    private static final String APK_SUBDIR = "updates";
    private static final String APK_FILENAME = "cobral-update.apk";
    private static final int CONNECT_TIMEOUT_MS = 15_000;
    private static final int READ_TIMEOUT_MS = 20_000;
    private static final int MAX_ATTEMPTS = 3;
    private static final long MAX_BYTES = 150L * 1024 * 1024;   // tope de seguridad (la app pesa ~5 MB)

    private volatile boolean busy = false;
    private volatile boolean cancelled = false;

    @PluginMethod
    public void canInstall(PluginCall call) {
        JSObject ret = new JSObject();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            ret.put("granted", getContext().getPackageManager().canRequestPackageInstalls());
        } else {
            ret.put("granted", true);
        }
        call.resolve(ret);
    }

    @PluginMethod
    public void openInstallPermissionSettings(PluginCall call) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            // "Acceso especial": no hay dialogo runtime, solo se puede llevar al usuario a la pantalla de Configuracion.
            Intent intent = new Intent(
                Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                Uri.parse("package:" + getContext().getPackageName())
            );
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
        }
        call.resolve();
    }

    @PluginMethod
    public void downloadAndInstall(PluginCall call) {
        if (busy) {
            call.reject("Ya hay una descarga en curso");
            return;
        }
        String url = call.getString("url");
        if (url == null || url.isEmpty()) {
            call.reject("Falta el parametro 'url'");
            return;
        }
        Uri parsed = Uri.parse(url);
        if (!"https".equals(parsed.getScheme()) || !ALLOWED_HOST.equals(parsed.getHost())) {
            call.reject("URL no permitida — debe ser https://" + ALLOWED_HOST + "/...");
            return;
        }
        String sha = call.getString("sha256");
        final String expectedSha = (sha == null || sha.trim().isEmpty()) ? null : sha.trim().toLowerCase();

        busy = true;
        cancelled = false;
        call.setKeepAlive(true);
        final Context ctx = getContext();
        new Thread(() -> {
            try {
                File apk = download(ctx, url);
                if (expectedSha != null) {
                    String got = sha256Of(apk);
                    if (!got.equals(expectedSha)) {
                        apk.delete();
                        throw new Exception("El archivo descargado no coincide con el esperado (SHA-256) — no se instaló nada");
                    }
                }
                Uri apkUri = FileProvider.getUriForFile(ctx, ctx.getPackageName() + ".fileprovider", apk);
                Intent install = new Intent(Intent.ACTION_VIEW);
                install.setDataAndType(apkUri, "application/vnd.android.package-archive");
                install.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
                // El instalador se abre desde el hilo principal.
                getActivity().runOnUiThread(() -> {
                    try {
                        ctx.startActivity(install);
                        busy = false;
                        call.resolve();
                    } catch (Exception e) {
                        busy = false;
                        call.reject("No se pudo abrir el instalador: " + e.getMessage());
                    }
                });
            } catch (Exception e) {
                Log.d(TAG, "downloadAndInstall: " + e);
                busy = false;
                call.reject(e.getMessage() != null ? e.getMessage() : "Error de descarga");
            }
        }, "cobral-updater").start();
    }

    /** Descarga con reintentos a <externalFiles>/updates/cobral-update.apk (via .part) y devuelve el archivo final. */
    private File download(Context ctx, String url) throws Exception {
        File dir = ctx.getExternalFilesDir(APK_SUBDIR);
        if (dir == null) {
            throw new Exception("No hay almacenamiento disponible para descargar la actualización");
        }
        dir.mkdirs();
        File[] old = dir.listFiles();
        if (old != null) {
            for (File f : old) {
                f.delete();   // nada de APK huerfanos de actualizaciones anteriores
            }
        }
        File part = new File(dir, APK_FILENAME + ".part");
        File finalFile = new File(dir, APK_FILENAME);
        Exception last = null;
        for (int attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            if (cancelled) {
                throw new Exception("Descarga cancelada");
            }
            HttpURLConnection conn = null;
            try {
                conn = (HttpURLConnection) new URL(url).openConnection();   // sigue los redirects de GitHub (https → https)
                conn.setConnectTimeout(CONNECT_TIMEOUT_MS);
                conn.setReadTimeout(READ_TIMEOUT_MS);
                conn.setInstanceFollowRedirects(true);
                conn.setRequestProperty("User-Agent", "Cobral-Updater");
                int code = conn.getResponseCode();
                if (code != HttpURLConnection.HTTP_OK) {
                    throw new Exception("GitHub respondió " + code);
                }
                long total = conn.getContentLengthLong();
                if (total > MAX_BYTES) {
                    throw new Exception("El archivo es demasiado grande");
                }
                long received = 0;
                long lastNotify = 0;
                try (InputStream in = conn.getInputStream(); OutputStream out = new FileOutputStream(part)) {
                    byte[] buf = new byte[32 * 1024];
                    int n;
                    while ((n = in.read(buf)) > 0) {
                        if (cancelled) {
                            throw new Exception("Descarga cancelada");
                        }
                        out.write(buf, 0, n);
                        received += n;
                        if (received > MAX_BYTES) {
                            throw new Exception("El archivo es demasiado grande");
                        }
                        long now = System.currentTimeMillis();
                        if (now - lastNotify > 250) {
                            lastNotify = now;
                            notifyProgress(received, total);
                        }
                    }
                }
                if (total > 0 && received != total) {
                    throw new Exception("Descarga incompleta (" + received + " de " + total + " bytes)");
                }
                notifyProgress(received, total > 0 ? total : received);
                if (!part.renameTo(finalFile)) {
                    throw new Exception("No se pudo guardar el archivo descargado");
                }
                return finalFile;
            } catch (Exception e) {
                last = e;
                Log.d(TAG, "intento " + attempt + "/" + MAX_ATTEMPTS + " falló: " + e);
                part.delete();
                if (attempt < MAX_ATTEMPTS) {
                    Thread.sleep(1500L * attempt);
                }
            } finally {
                if (conn != null) {
                    conn.disconnect();
                }
            }
        }
        throw new Exception("No se pudo descargar la actualización" + (last != null ? ": " + last.getMessage() : "") + ". Revisa tu conexión e inténtalo de nuevo.");
    }

    private void notifyProgress(long received, long total) {
        JSObject ev = new JSObject();
        ev.put("received", received);
        ev.put("total", total);
        notifyListeners("downloadProgress", ev);
    }

    private static String sha256Of(File f) throws Exception {
        MessageDigest md = MessageDigest.getInstance("SHA-256");
        try (FileInputStream in = new FileInputStream(f)) {
            byte[] buf = new byte[64 * 1024];
            int n;
            while ((n = in.read(buf)) > 0) {
                md.update(buf, 0, n);
            }
        }
        StringBuilder sb = new StringBuilder();
        for (byte b : md.digest()) {
            sb.append(String.format("%02x", b));
        }
        return sb.toString();
    }

    @Override
    protected void handleOnDestroy() {
        super.handleOnDestroy();
        cancelled = true;
    }
}
