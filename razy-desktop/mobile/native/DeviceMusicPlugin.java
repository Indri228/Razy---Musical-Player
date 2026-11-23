package app.razy.player;

import android.content.ContentResolver;
import android.content.ContentUris;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.provider.MediaStore;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;

/** Музыка телефона (MediaStore): list — список треков, copy — копия трека в кэш приложения, clean — удалить копию. */
@CapacitorPlugin(
    name = "DeviceMusic",
    permissions = {
        @Permission(alias = "audio", strings = { "android.permission.READ_MEDIA_AUDIO" }),
        @Permission(alias = "storage", strings = { "android.permission.READ_EXTERNAL_STORAGE" })
    }
)
public class DeviceMusicPlugin extends Plugin {

    private String alias() {
        return Build.VERSION.SDK_INT >= 33 ? "audio" : "storage";
    }

    @PluginMethod
    public void list(PluginCall call) {
        if (getPermissionState(alias()) != PermissionState.GRANTED) {
            requestPermissionForAlias(alias(), call, "permDone");
            return;
        }
        doList(call);
    }

    @PermissionCallback
    private void permDone(PluginCall call) {
        if (getPermissionState(alias()) == PermissionState.GRANTED) {
            doList(call);
        } else {
            call.reject("denied");
        }
    }

    private void doList(PluginCall call) {
        try {
            String[] proj = {
                MediaStore.Audio.Media._ID,
                MediaStore.Audio.Media.TITLE,
                MediaStore.Audio.Media.ARTIST,
                MediaStore.Audio.Media.ALBUM,
                MediaStore.Audio.Media.DURATION,
                MediaStore.Audio.Media.DISPLAY_NAME,
                MediaStore.Audio.Media.MIME_TYPE,
                MediaStore.Audio.Media.SIZE
            };
            String sel = MediaStore.Audio.Media.IS_MUSIC + " != 0 AND " + MediaStore.Audio.Media.DURATION + " >= 15000";
            JSArray out = new JSArray();
            ContentResolver cr = getContext().getContentResolver();
            Cursor c = cr.query(MediaStore.Audio.Media.EXTERNAL_CONTENT_URI, proj, sel, null,
                MediaStore.Audio.Media.TITLE + " COLLATE NOCASE ASC");
            if (c != null) {
                try {
                    while (c.moveToNext()) {
                        JSObject o = new JSObject();
                        o.put("id", String.valueOf(c.getLong(0)));
                        o.put("title", c.getString(1) == null ? "" : c.getString(1));
                        String ar = c.getString(2);
                        o.put("artist", (ar == null || ar.equals("<unknown>")) ? "" : ar);
                        String al = c.getString(3);
                        o.put("album", (al == null || al.equals("<unknown>")) ? "" : al);
                        o.put("dur", Math.round(c.getLong(4) / 1000.0));
                        o.put("name", c.getString(5) == null ? "" : c.getString(5));
                        o.put("mime", c.getString(6) == null ? "" : c.getString(6));
                        o.put("size", c.getLong(7));
                        out.put(o);
                    }
                } finally {
                    c.close();
                }
            }
            JSObject r = new JSObject();
            r.put("tracks", out);
            call.resolve(r);
        } catch (Exception e) {
            call.reject("list: " + e.getMessage());
        }
    }

    @PluginMethod
    public void copy(PluginCall call) {
        String id = call.getString("id");
        if (id == null || !id.matches("[0-9]+")) {
            call.reject("bad id");
            return;
        }
        try {
            Uri u = ContentUris.withAppendedId(MediaStore.Audio.Media.EXTERNAL_CONTENT_URI, Long.parseLong(id));
            File dir = new File(getContext().getCacheDir(), "import");
            dir.mkdirs();
            File out = new File(dir, id + ".bin");
            InputStream in = getContext().getContentResolver().openInputStream(u);
            if (in == null) {
                call.reject("no stream");
                return;
            }
            OutputStream os = new FileOutputStream(out);
            try {
                byte[] buf = new byte[64 * 1024];
                int n;
                while ((n = in.read(buf)) > 0) {
                    os.write(buf, 0, n);
                }
            } finally {
                try { in.close(); } catch (Exception ignored) { }
                os.close();
            }
            JSObject r = new JSObject();
            r.put("path", out.getAbsolutePath());
            call.resolve(r);
        } catch (Exception e) {
            call.reject("copy: " + e.getMessage());
        }
    }

    @PluginMethod
    public void clean(PluginCall call) {
        try {
            File dir = new File(getContext().getCacheDir(), "import");
            File[] fs = dir.listFiles();
            if (fs != null) {
                for (File f : fs) {
                    f.delete();
                }
            }
        } catch (Exception ignored) { }
        call.resolve();
    }
}
