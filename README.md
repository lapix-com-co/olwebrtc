# Otra Librería WebRTC (olwebrtc)

![npm](https://img.shields.io/npm/dm/@lapix/olwebrtc)
![npm](https://img.shields.io/npm/v/@lapix/olwebrtc)

Yet another WebRTC Library.

## Usage

```typescript
import {FetchCheckNetworkStatus} from "./fetch-check-network-status";
import {GraphqlSignaling} from "./graphql-signaling";

const apolloClient = newApolloClient()
const call = new WebRTCCall({
  // Zero Log everything, Five silence.
  logLevel: 5,
  // Will sanitize the sdp, browsers will not support that.
  allowSDPTransform: true,
  // If could not find a valid ice, then will try to make
  // the call again.
  allowIceStalledChecking: true,
  // If the ICE connection state is disconnected it will
  // check the bitrate in the next 5s and if it get worst 
  // the will restart the ICE candidates.
  allowBitrateChecking: true,
  // Max bandwidth.
  bandwidth: 300,
  // Will check the network connection to if the peer connection
  // is closed before the call has been finished.
  network: new FetchCheckNetworkStatus(),
  signaling: new GraphqlSignaling(apolloClient as ApolloClient<any>),
  rtcConfiguration: {
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  },
});

call.start({
  roomId: "vip-room",
  mediaStreamConstrains: {
    video: {
      width: { min: 720 },
      height: { min: 480 },
      frameRate: { max: 30 },
    },
    audio: {
      noiseSuppression: true,
    },
  },
});

call.on("change", () => console.log(call))
call.on("error", err => console.error(err))
call.on("finish", err => console.warn("Has been finished"))

call.on("local-track-change", () => {
    this.localStream = call.localStream;
})
call.on("track-change", () => {
    this.peerStream = call.peerStream;
})

// are Video or audio enabled?
this.video = call.video; 
this.audio = call.audio; 

// Update local controls.
this.toggleAudio();
this.toggleVideo();

// Peer controls.
const {video, audio} = call.externalControls;

// Has the call been finished.
this.finished = call.finished;
this.finish();
```

## GraphQL
Signaling server must implement the following [graphql schema](https://github.com/lapix-com-co/olwebrtc/src/schema.graphqls).

## ReactNative
It works with ReactNative, you only need to replace the
`FetchCheckNetworkStatus` for `RNCheckNetworkStatus`.

## TODO
- [ ] (*) Test
- [ ] Docs
- [ ] Disconnection Strategy in ReactNative.
- [ ] Fix the max bandwidth.
- [ ] Make it flexible.

## License
ISC
