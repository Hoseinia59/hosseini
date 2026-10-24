package com.yadakprice.app;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Bundle;
import android.provider.OpenableColumns;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import androidx.annotation.NonNull;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import androidx.webkit.WebViewAssetLoader;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class MainActivity extends AppCompatActivity {

    private WebView webView;

    private static final String VIRTUAL_DOMAIN = "appassets.androidplatform.net";
    private static final int WEB_PERMISSION_REQUEST = 1001;
    private static final int FILE_CHOOSER_REQUEST = 1002;

    private ValueCallback<Uri[]> fileChooserCallback;
    private PermissionRequest pendingWebPermissionRequest;

    private final ExecutorService fileExecutor = Executors.newSingleThreadExecutor();
    private final NativeFileBridge nativeFileBridge = new NativeFileBridge();

    private final class NativeFileBridge {
        private volatile byte[] pendingBytes;
        private volatile String pendingName = "";

        synchronized void setPendingFile(String name, byte[] bytes) {
            pendingName = (name == null || name.trim().isEmpty()) ? "import.xlsx" : name;
            pendingBytes = bytes;
        }

        @android.webkit.JavascriptInterface
        public boolean hasPendingFile() {
            return pendingBytes != null && pendingBytes.length > 0;
        }

        @android.webkit.JavascriptInterface
        public String getPendingFileName() {
            return pendingName;
        }

        @android.webkit.JavascriptInterface
        public int getPendingFileSize() {
            return pendingBytes == null ? 0 : pendingBytes.length;
        }

        @android.webkit.JavascriptInterface
        public String readPendingFileChunk(int offset, int length) {
            byte[] bytes = pendingBytes;
            if (bytes == null || offset < 0 || offset >= bytes.length || length <= 0) {
                return "";
            }

            int safeLength = Math.min(length, 64 * 1024);
            int end = Math.min(bytes.length, offset + safeLength);
            byte[] slice = Arrays.copyOfRange(bytes, offset, end);

            return android.util.Base64.encodeToString(slice, android.util.Base64.NO_WRAP);
        }

        @android.webkit.JavascriptInterface
        public synchronized void clearPendingFile() {
            pendingBytes = null;
            pendingName = "";
        }
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        webView = new WebView(this);
        setContentView(webView);

        WebViewAssetLoader assetLoader =
                new WebViewAssetLoader.Builder()
                        .setDomain(VIRTUAL_DOMAIN)
                        .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                        .build();

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(true);
        settings.setAllowContentAccess(true);
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);

        settings.setAllowUniversalAccessFromFileURLs(true);
        settings.setAllowFileAccessFromFileURLs(true);

        webView.addJavascriptInterface(nativeFileBridge, "AndroidFileBridge");

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(
                    WebView view,
                    WebResourceRequest request
            ) {
                return assetLoader.shouldInterceptRequest(request.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return false;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                view.evaluateJavascript(
                        "if (window.__checkNativeSelectedFile) { window.__checkNativeSelectedFile(); }",
                        null
                );
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(@NonNull PermissionRequest request) {
                runOnUiThread(() -> handleWebPermissionRequest(request));
            }

            @Override
            public void onPermissionRequestCanceled(@NonNull PermissionRequest request) {
                if (pendingWebPermissionRequest == request) {
                    pendingWebPermissionRequest = null;
                }
            }

            @Override
            public boolean onShowFileChooser(
                    WebView view,
                    ValueCallback<Uri[]> callback,
                    FileChooserParams params
            ) {
                if (fileChooserCallback != null) {
                    fileChooserCallback.onReceiveValue(null);
                }

                fileChooserCallback = callback;

                try {
                    Intent intent = params.createIntent();

                    if (intent.getType() == null || intent.getType().isEmpty()) {
                        intent.setType("*/*");
                    }

                    String[] mimeTypes = new String[] {
                            "application/vnd.ms-excel",
                            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                            "text/csv",
                            "text/plain",
                            "application/pdf"
                    };

                    intent.putExtra(Intent.EXTRA_MIME_TYPES, mimeTypes);
                    intent.addCategory(Intent.CATEGORY_OPENABLE);

                    startActivityForResult(intent, FILE_CHOOSER_REQUEST);
                    return true;

                } catch (Exception e) {
                    fileChooserCallback = null;
                    callback.onReceiveValue(null);

                    Toast.makeText(
                            MainActivity.this,
                            "بازکردن انتخاب‌گر فایل ممکن نشد.",
                            Toast.LENGTH_LONG
                    ).show();

                    return false;
                }
            }
        });

        if (savedInstanceState != null) {
            webView.restoreState(savedInstanceState);

            if (webView.getUrl() == null || webView.getUrl().isEmpty()) {
                loadHomePage();
            }
        } else {
            loadHomePage();
        }
    }

    private void loadHomePage() {
        webView.loadUrl("https://" + VIRTUAL_DOMAIN + "/assets/www/index.html");
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        if (webView != null) {
            webView.saveState(outState);
        }
        super.onSaveInstanceState(outState);
    }

    private void handleWebPermissionRequest(@NonNull PermissionRequest request) {
        Uri origin = request.getOrigin();

        if (!"https".equals(origin.getScheme())
                || !VIRTUAL_DOMAIN.equals(origin.getHost())) {
            request.deny();
            return;
        }

        boolean needsCamera = false;
        boolean needsMicrophone = false;

        for (String resource : request.getResources()) {
            if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource)) {
                needsCamera = true;
            } else if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)) {
                needsMicrophone = true;
            } else {
                request.deny();
                return;
            }
        }

        List<String> missingPermissions = new ArrayList<>();

        if (needsCamera
                && ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA)
                != PackageManager.PERMISSION_GRANTED) {
            missingPermissions.add(Manifest.permission.CAMERA);
        }

        if (needsMicrophone
                && ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
                != PackageManager.PERMISSION_GRANTED) {
            missingPermissions.add(Manifest.permission.RECORD_AUDIO);
        }

        if (missingPermissions.isEmpty()) {
            request.grant(request.getResources());
            return;
        }

        if (pendingWebPermissionRequest != null) {
            pendingWebPermissionRequest.deny();
        }

        pendingWebPermissionRequest = request;

        ActivityCompat.requestPermissions(
                this,
                missingPermissions.toArray(new String[0]),
                WEB_PERMISSION_REQUEST
        );
    }

    private void finishWebPermissionRequest() {
        PermissionRequest request = pendingWebPermissionRequest;
        pendingWebPermissionRequest = null;

        if (request == null) {
            return;
        }

        List<String> grantedResources = new ArrayList<>();

        for (String resource : request.getResources()) {
            if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource)
                    && ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA)
                    == PackageManager.PERMISSION_GRANTED) {
                grantedResources.add(resource);

            } else if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)
                    && ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
                    == PackageManager.PERMISSION_GRANTED) {
                grantedResources.add(resource);
            }
        }

        if (grantedResources.isEmpty()) {
            request.deny();
        } else {
            request.grant(grantedResources.toArray(new String[0]));
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);

        if (requestCode == FILE_CHOOSER_REQUEST) {
            Uri selectedUri = null;

            if (resultCode == Activity.RESULT_OK && data != null) {
                selectedUri = data.getData();

                if (selectedUri == null && data.getClipData() != null
                        && data.getClipData().getItemCount() > 0) {
                    selectedUri = data.getClipData().getItemAt(0).getUri();
                }
            }

            if (fileChooserCallback != null) {
                Uri[] results = selectedUri == null ? null : new Uri[]{selectedUri};
                fileChooserCallback.onReceiveValue(results);
                fileChooserCallback = null;
            } else if (selectedUri != null) {
                fileExecutor.execute(() -> recoverSelectedFile(selectedUri));
            }
        }
    }

    private void recoverSelectedFile(Uri uri) {
        try (InputStream input = getContentResolver().openInputStream(uri);
             ByteArrayOutputStream output = new ByteArrayOutputStream()) {

            if (input == null) {
                return;
            }

            byte[] buffer = new byte[32 * 1024];
            int read;
            while ((read = input.read(buffer)) != -1) {
                output.write(buffer, 0, read);
            }

            String name = "import.xlsx";

            try (android.database.Cursor cursor = getContentResolver().query(
                    uri,
                    new String[]{OpenableColumns.DISPLAY_NAME},
                    null,
                    null,
                    null
            )) {
                if (cursor != null && cursor.moveToFirst()) {
                    int column = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                    if (column >= 0 && cursor.getString(column) != null) {
                        name = cursor.getString(column);
                    }
                }
            }

            nativeFileBridge.setPendingFile(name, output.toByteArray());

            runOnUiThread(() -> {
                if (webView != null) {
                    webView.evaluateJavascript(
                            "if (window.__checkNativeSelectedFile) { window.__checkNativeSelectedFile(); }",
                            null
                    );
                }
            });

        } catch (Exception e) {
            runOnUiThread(() -> Toast.makeText(
                    MainActivity.this,
                    "خواندن فایل انتخاب‌شده ناموفق بود.",
                    Toast.LENGTH_LONG
            ).show());
        }
    }

    @Override
    protected void onDestroy() {
        if (pendingWebPermissionRequest != null) {
            pendingWebPermissionRequest.deny();
            pendingWebPermissionRequest = null;
        }

        if (fileChooserCallback != null) {
            fileChooserCallback.onReceiveValue(null);
            fileChooserCallback = null;
        }

        if (webView != null) {
            webView.destroy();
            webView = null;
        }

        fileExecutor.shutdownNow();

        super.onDestroy();
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    public void onRequestPermissionsResult(
            int requestCode,
            @NonNull String[] permissions,
            @NonNull int[] grantResults
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);

        if (requestCode == WEB_PERMISSION_REQUEST) {
            finishWebPermissionRequest();

            boolean cameraGranted = ContextCompat.checkSelfPermission(
                    this,
                    Manifest.permission.CAMERA
            ) == PackageManager.PERMISSION_GRANTED;

            if (!cameraGranted) {
                Toast.makeText(
                        this,
                        "برای اسکن بارکد باید اجازه دوربین را فعال کنی.",
                        Toast.LENGTH_LONG
                ).show();
            }
        }
    }
}