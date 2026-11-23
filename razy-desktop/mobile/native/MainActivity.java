package app.razy.player;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(DeviceMusicPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
