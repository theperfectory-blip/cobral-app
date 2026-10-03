package cl.cobral.ventas;

import android.os.Bundle;
import android.view.WindowManager;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // Auto-actualizador (descarga + instala el APK nuevo desde GitHub Releases) — ver AppUpdaterPlugin.java.
        // Debe registrarse antes de super.onCreate() (bridge de Capacitor).
        registerPlugin(AppUpdaterPlugin.class);
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    }
}
