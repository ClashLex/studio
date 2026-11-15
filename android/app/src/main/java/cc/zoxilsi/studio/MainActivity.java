package cc.zoxilsi.studio;

import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.webkit.WebView;

import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.WebViewListener;

public class MainActivity extends BridgeActivity {
    private int bottomInsetDp;

    private final WebViewListener bottomInsetListener = new WebViewListener() {
        @Override
        public void onPageCommitVisible(WebView view, String url) {
            updateBottomInset(view);
        }
    };

    @Override
    public void onCreate(Bundle savedInstanceState) {
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        getWindow().setNavigationBarColor(Color.TRANSPARENT);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            getWindow().setNavigationBarContrastEnforced(false);
        }
        super.onCreate(savedInstanceState);

        if (getBridge() != null) {
            getBridge().addWebViewListener(bottomInsetListener);
        }

        View decorView = getWindow().getDecorView();
        ViewCompat.setOnApplyWindowInsetsListener(decorView, (view, insets) -> {
            Insets safeInsets = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout()
            );
            view.setPadding(safeInsets.left, safeInsets.top, safeInsets.right, 0);
            bottomInsetDp = Math.round(
                safeInsets.bottom / getResources().getDisplayMetrics().density
            );
            if (getBridge() != null && getBridge().getWebView() != null) {
                updateBottomInset(getBridge().getWebView());
            }
            return WindowInsetsCompat.CONSUMED;
        });
        ViewCompat.requestApplyInsets(decorView);
    }

    @Override
    public void onDestroy() {
        if (getBridge() != null) {
            getBridge().removeWebViewListener(bottomInsetListener);
        }
        super.onDestroy();
    }

    private void updateBottomInset(WebView webView) {
        webView.evaluateJavascript(
            "document.documentElement.style.setProperty('--android-bottom-inset', '" +
            bottomInsetDp +
            "px')",
            null
        );
    }
}
