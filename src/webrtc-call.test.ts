import { WebRTCCall, WebRTCCallOptions } from "./webrtc-call";
import { NetworkStatus } from "./call";
import { Signaling } from "./signaling";

const webRTCCallOptions: WebRTCCallOptions = {
  logLevel: 5,
  allowSDPTransform: false,
  allowIceStalledChecking: false,
  allowBitrateChecking: false,
  bandwidth: 300,
  network: {} as NetworkStatus,
  signaling: {connected: false} as Signaling,
  rtcConfiguration: {
    iceServers: [],
  },
};

test('should initialize the call', () => {
  const call = new WebRTCCall(webRTCCallOptions);

  expect(call.connected).toBe(false);
});
