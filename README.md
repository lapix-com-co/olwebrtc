# Otra Librería WebRTC (olwebrtc)

![npm](https://img.shields.io/npm/dm/@lapix/olwebrtc)
![npm](https://img.shields.io/npm/v/@lapix/olwebrtc)

Yet another WebRTC Library.

## Usage

```javascript
import {WebRTCCall} from '@lapix/olwebrtc/dist/webrtc-call';
import {GraphqlSignaling} from '@lapix/olwebrtc/dist/graphql-signaling';
import {FetchCheckNetworkStatus} from '@lapix/olwebrtc/dist/fetch-check-network-status';
import newCallClient from "@lapix/olwebrtc/dist/graphql-client"

// Split the mutations and subscriptions based on the
// current graphql implementation.
const apolloClient = newCallClient({uri: "wss://my-signaling-server.io/query"}, currentApolloClient)

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
  signaling: new GraphqlSignaling(apolloClient),
  rtcConfiguration: {
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  },
});

call.start({
  roomId: "vip-room",
  mediaStreamConstrains: {
    camera: {
      video: {
        width: { min: 720 },
        height: { min: 480 },
        frameRate: { max: 30 },
      },
      audio: {
        noiseSuppression: true,
      },
    },
    // By default it will share the camera stream, if you want to
    // share your screen just call the `shareScreen` method, by now
    // it does not renegotiate, it just close the connection and start
    // a new one, then if you what to share the camera again just call
    // the `shareVideo` method.
    screen: {
      video: true,
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

// Share screen or camera.
call.shareScreen();
call.shareVideo();

// Has the call been finished.
this.finished = call.finished;
this.finish();
```

## GraphQL
Signaling server must implement the following [graphql schema](https://github.com/lapix-com-co/olwebrtc/tree/master/src/schema.graphqls).

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
