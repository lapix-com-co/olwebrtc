import { Statistics } from "./call";

export interface BitRateStats {
  video: { input: number; output: number };
  audio: { input: number; output: number };
}

interface StatRecord {
  bytes: number;
  timestamp: number;
}

export class Bitrate implements Statistics<BitRateStats> {
  private inputAudioStats?: StatRecord;
  private outputVideoStats?: StatRecord;

  private inputVideoStats?: StatRecord;
  private outputAudioStats?: StatRecord;

  async find(peer: RTCPeerConnection): Promise<BitRateStats> {
    const stats = await peer.getStats(null);
    let inputVideoBitrate: number = 0;
    let outputVideoBitrate: number = 0;
    let inputAudioBitrate: number = 0;
    let outputAudioBitrate: number = 0;

    stats.forEach((report) => {
      const sentRecord: StatRecord = {
        bytes: report.bytesSent || 0,
        timestamp: report.timestamp,
      };
      const receivedRecord: StatRecord = {
        bytes: report.bytesReceived || 0,
        timestamp: report.timestamp,
      };

      switch (report.type) {
        case "inbound-rtp":
          if (report.mediaType === "video") {
            if (this.inputVideoStats) {
              inputVideoBitrate = Bitrate.calcBitrate(
                receivedRecord,
                this.inputVideoStats
              );
            }
            this.inputVideoStats = receivedRecord;
          } else if (report.mediaType === "audio") {
            if (this.inputAudioStats) {
              inputAudioBitrate = Bitrate.calcBitrate(
                receivedRecord,
                this.inputAudioStats
              );
            }
            this.inputAudioStats = receivedRecord;
          }
          break;
        case "outbound-rtp":
          if (report.mediaType === "video") {
            if (this.outputVideoStats) {
              outputVideoBitrate = Bitrate.calcBitrate(
                sentRecord,
                this.outputVideoStats
              );
            }
            this.outputVideoStats = sentRecord;
          } else if (report.mediaType === "audio") {
            if (this.outputAudioStats) {
              outputAudioBitrate = Bitrate.calcBitrate(
                sentRecord,
                this.outputAudioStats
              );
            }
            this.outputAudioStats = sentRecord;
          }
          break;
      }
    });

    return {
      video: {
        input: inputVideoBitrate,
        output: outputVideoBitrate,
      },
      audio: {
        input: inputAudioBitrate,
        output: outputAudioBitrate,
      },
    };
  }

  private static calcBitrate(
    current: StatRecord,
    previous?: StatRecord
  ): number {
    let result = 0;
    if (previous) {
      result = Math.floor(
        (8 * (current.bytes - previous.bytes)) /
          (current.timestamp - previous.timestamp)
      );
    }
    return result;
  }
}
