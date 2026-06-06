// AirPlayCaster — tiny macOS app that plays a video URL and exposes the AirPlay
// route picker so you can send it to your Apple TV / AirPlay-capable smart TV.
//
// Written in Objective-C (compiled with clang) on purpose: it sidesteps the broken
// Swift compiler/SDK version mismatch on this machine's Command Line Tools.
//
// Launched by the native-messaging host with:
//   open -n AirPlayCaster.app --args --url <URL> --referer <REF> --title <T> --cookie <C> --ua <UA>

#import <Cocoa/Cocoa.h>
#import <AVKit/AVKit.h>
#import <AVFoundation/AVFoundation.h>

static NSString *ArgValue(NSString *name) {
    NSArray<NSString *> *args = [[NSProcessInfo processInfo] arguments];
    NSUInteger i = [args indexOfObject:name];
    if (i != NSNotFound && i + 1 < args.count) {
        NSString *v = args[i + 1];
        if (v.length > 0) return v;
    }
    return nil;
}

@interface AppDelegate : NSObject <NSApplicationDelegate>
@property (strong) NSWindow *window;
@property (strong) AVPlayer *player;
@property (strong) AVPlayerView *playerView;
@property (strong) AVRoutePickerView *picker;
@property (strong) AVPlayerItem *item;
@property (assign) BOOL started;
@end

@implementation AppDelegate

- (void)applicationDidFinishLaunching:(NSNotification *)note {
    NSString *urlStr = ArgValue(@"--url");
    NSURL *url = urlStr ? [NSURL URLWithString:urlStr] : nil;
    if (!url) {
        [self fail:@"No se recibió una URL de video válida."];
        return;
    }

    NSMutableDictionary *headers = [NSMutableDictionary dictionary];
    NSString *referer = ArgValue(@"--referer");
    NSString *ua = ArgValue(@"--ua");
    NSString *cookie = ArgValue(@"--cookie");
    if (referer) headers[@"Referer"] = referer;
    if (ua) headers[@"User-Agent"] = ua;
    if (cookie) headers[@"Cookie"] = cookie;
    NSString *title = ArgValue(@"--title") ?: @"AirPlay";

    NSDictionary *opts = headers.count ? @{ @"AVURLAssetHTTPHeaderFieldsKey": headers } : nil;
    AVURLAsset *asset = [AVURLAsset URLAssetWithURL:url options:opts];
    self.item = [AVPlayerItem playerItemWithAsset:asset];

    self.player = [AVPlayer playerWithPlayerItem:self.item];
    self.player.allowsExternalPlayback = YES;
    // Don't sit in a buffering wait state — important so AirPlay actually starts pushing.
    self.player.automaticallyWaitsToMinimizeStalling = NO;

    NSRect frame = NSMakeRect(0, 0, 960, 560);
    self.playerView = [[AVPlayerView alloc] initWithFrame:frame];
    self.playerView.player = self.player;
    self.playerView.controlsStyle = AVPlayerViewControlsStyleFloating;
    self.playerView.showsFullScreenToggleButton = YES;

    self.window = [[NSWindow alloc] initWithContentRect:frame
                                             styleMask:(NSWindowStyleMaskTitled |
                                                        NSWindowStyleMaskClosable |
                                                        NSWindowStyleMaskMiniaturizable |
                                                        NSWindowStyleMaskResizable)
                                               backing:NSBackingStoreBuffered
                                                 defer:NO];
    self.window.title = title;
    [self.window center];
    self.window.contentView = self.playerView;
    self.window.releasedWhenClosed = NO;

    // Explicit, always-visible AirPlay button (top-right) in addition to the
    // one AVPlayerView shows in its floating controls.
    self.picker = [[AVRoutePickerView alloc] initWithFrame:NSMakeRect(frame.size.width - 60,
                                                                      frame.size.height - 46, 44, 32)];
    self.picker.autoresizingMask = (NSViewMinXMargin | NSViewMinYMargin);
    [self.playerView addSubview:self.picker];

    // Observe readiness, AirPlay activation, and failures.
    [self.item addObserver:self forKeyPath:@"status" options:NSKeyValueObservingOptionNew context:NULL];
    [self.player addObserver:self forKeyPath:@"externalPlaybackActive" options:NSKeyValueObservingOptionNew context:NULL];
    [self.player addObserver:self forKeyPath:@"timeControlStatus" options:NSKeyValueObservingOptionNew context:NULL];
    [[NSNotificationCenter defaultCenter] addObserver:self
                                             selector:@selector(playbackStalled:)
                                                 name:AVPlayerItemPlaybackStalledNotification
                                               object:self.item];
    [[NSNotificationCenter defaultCenter] addObserver:self
                                             selector:@selector(failedToEnd:)
                                                 name:AVPlayerItemFailedToPlayToEndTimeNotification
                                               object:self.item];
    [[NSNotificationCenter defaultCenter] addObserver:self
                                             selector:@selector(newErrorLog:)
                                                 name:AVPlayerItemNewErrorLogEntryNotification
                                               object:self.item];

    [self.window makeKeyAndOrderFront:nil];
    [NSApp activateIgnoringOtherApps:YES];
    [self startPlayback];

    // Best-effort: pop the AirPlay menu automatically so the TV list shows up.
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.9 * NSEC_PER_SEC)),
                   dispatch_get_main_queue(), ^{ [self tryOpenRoutePicker]; });
}

- (void)startPlayback {
    // Force immediate playback instead of waiting for the buffer heuristic. This is
    // what gets AirPlay to actually start streaming to the TV.
    [self.player playImmediatelyAtRate:1.0];
}

- (void)observeValueForKeyPath:(NSString *)keyPath ofObject:(id)object
                        change:(NSDictionary *)change context:(void *)context {
    if ([keyPath isEqualToString:@"status"]) {
        if (self.item.status == AVPlayerItemStatusReadyToPlay) {
            [self startPlayback];
        } else if (self.item.status == AVPlayerItemStatusFailed) {
            NSString *msg = self.item.error.localizedDescription ?: @"Error desconocido.";
            [self fail:[NSString stringWithFormat:
                @"No se pudo cargar el video.\n\n%@\n\nProbablemente requiere inicio de sesión / DRM, "
                @"o el servidor exige cookies que no se pudieron pasar.", msg]];
        }
    } else if ([keyPath isEqualToString:@"externalPlaybackActive"]) {
        // Route just switched to/from AirPlay — (re)kick playback so the TV gets frames.
        if (self.player.externalPlaybackActive) {
            dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.3 * NSEC_PER_SEC)),
                           dispatch_get_main_queue(), ^{ [self startPlayback]; });
        }
    } else if ([keyPath isEqualToString:@"timeControlStatus"]) {
        // If the player parks in "waiting" with no good reason, nudge it.
        if (self.player.timeControlStatus == AVPlayerTimeControlStatusWaitingToPlayAtSpecifiedRate &&
            self.item.status == AVPlayerItemStatusReadyToPlay) {
            [self startPlayback];
        }
    }
}

- (void)playbackStalled:(NSNotification *)n {
    // Try to recover from a stall by forcing playback again.
    [self startPlayback];
}

- (void)newErrorLog:(NSNotification *)n {
    [self dumpDiagnostics:@"new-error-log-entry"];
}

- (void)failedToEnd:(NSNotification *)n {
    NSError *err = n.userInfo[AVPlayerItemFailedToPlayToEndTimeErrorKey];
    [self dumpDiagnostics:[NSString stringWithFormat:@"failedToPlayToEndTime: %@ (code %ld, %@)",
                           err.localizedDescription, (long)err.code, err.domain]];
    NSString *msg = err.localizedDescription ?: @"La reproducción se interrumpió.";
    [self fail:[NSString stringWithFormat:
        @"AirPlay conectó pero el video no se pudo reproducir.\n\n%@\n\n(Detalle guardado en player.log)", msg]];
}

// Dump AVPlayerItem error+access logs to native/player.log for diagnosis.
- (void)dumpDiagnostics:(NSString *)reason {
    // arguments[0] = .../native/AirPlayCaster.app/Contents/MacOS/AirPlayCaster
    // Go up 4 levels to reach the native/ dir.
    NSString *base = [NSProcessInfo processInfo].arguments[0];
    for (int i = 0; i < 4; i++) base = [base stringByDeletingLastPathComponent];
    NSString *path = (base.length > 1) ? [base stringByAppendingPathComponent:@"player.log"]
                                       : @"/tmp/airplay_player.log";

    NSMutableString *s = [NSMutableString string];
    [s appendFormat:@"\n===== %@ =====\n", reason];
    [s appendFormat:@"status=%ld  externalPlaybackActive=%d  timeControl=%ld\n",
        (long)self.item.status, self.player.externalPlaybackActive, (long)self.player.timeControlStatus];

    AVPlayerItemErrorLog *el = [self.item errorLog];
    for (AVPlayerItemErrorLogEvent *e in el.events) {
        [s appendFormat:@"[ERR] httpStatus=%ld domain=%@ comment=%@\n      uri=%@\n      server=%@\n",
            (long)e.errorStatusCode, e.errorDomain, e.errorComment, e.URI, e.serverAddress];
    }
    AVPlayerItemAccessLog *al = [self.item accessLog];
    for (AVPlayerItemAccessLogEvent *a in al.events) {
        [s appendFormat:@"[ACC] uri=%@\n      bitrate=%.0f stalls=%ld dropped=%ld bytes=%lld\n",
            a.URI, a.indicatedBitrate, (long)a.numberOfStalls, (long)a.numberOfDroppedVideoFrames,
            (long long)a.numberOfBytesTransferred];
    }
    NSFileHandle *fh = [NSFileHandle fileHandleForWritingAtPath:path];
    if (!fh) { [[NSFileManager defaultManager] createFileAtPath:path contents:nil attributes:nil];
               fh = [NSFileHandle fileHandleForWritingAtPath:path]; }
    [fh seekToEndOfFile];
    [fh writeData:[s dataUsingEncoding:NSUTF8StringEncoding]];
    [fh closeFile];
}

// AVRoutePickerView wraps an NSButton; clicking it opens the device menu.
- (BOOL)clickButtonIn:(NSView *)view {
    if ([view isKindOfClass:[NSButton class]]) { [(NSButton *)view performClick:nil]; return YES; }
    for (NSView *sub in view.subviews) { if ([self clickButtonIn:sub]) return YES; }
    return NO;
}
- (void)tryOpenRoutePicker { [self clickButtonIn:self.picker]; }

- (void)fail:(NSString *)message {
    NSAlert *alert = [[NSAlert alloc] init];
    alert.messageText = @"AirPlay Tab Caster";
    alert.informativeText = message;
    alert.alertStyle = NSAlertStyleWarning;
    [alert addButtonWithTitle:@"Cerrar"];
    [alert runModal];
    [NSApp terminate:nil];
}

- (BOOL)applicationShouldTerminateAfterLastWindowClosed:(NSApplication *)sender { return YES; }
@end

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        NSApplication *app = [NSApplication sharedApplication];
        AppDelegate *delegate = [[AppDelegate alloc] init];
        app.delegate = delegate;
        [app setActivationPolicy:NSApplicationActivationPolicyRegular];
        [app run];
    }
    return 0;
}
