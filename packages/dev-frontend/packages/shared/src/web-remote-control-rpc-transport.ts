import { z } from "zod";
import { PROTOCOL_V4_LIMITS } from "./zcode-protocol-v4/core.js";
import {
  decodeWireBase64,
  encodeWireBytesBase64,
} from "./zcode-protocol-v4/wire-binary.js";

export const WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS = {
  maxPhysicalFrameBytes: PROTOCOL_V4_LIMITS.maxFrameBytes,
  maxMessageBytes: 16 * 1024 * 1024,
  maxFragments: 64,
  transportIdMaxChars: PROTOCOL_V4_LIMITS.transportEnvelopeIdMaxChars,
} as const;

const positiveSafeIntegerSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const nonnegativeSafeIntegerSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const webRemoteControlRpcTransportIdSchema = z
  .string()
  .min(1)
  .max(WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.transportIdMaxChars)
  .regex(/^[A-Za-z0-9._~-]+$/u);

export const webRemoteControlRpcTransportChecksumSchema = z
  .object({
    algorithm: z.literal("crc32"),
    value: z.string().regex(/^[0-9a-f]{8}$/u),
  })
  .strict();
export type WebRemoteControlRpcTransportChecksum = z.infer<
  typeof webRemoteControlRpcTransportChecksumSchema
>;

function isCanonicalBase64(value: string): boolean {
  // Zod 的后续 refine 不保证在 max issue 后短路；先按 raw string 做硬闸，避免先分配 decoded buffer。
  if (
    value.length < 4 ||
    value.length > WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxPhysicalFrameBytes
  ) {
    return false;
  }
  const decoded = decodeWireBase64(value);
  return decoded !== null && decoded.byteLength > 0 && encodeWireBytesBase64(decoded) === value;
}

export const webRemoteControlRpcTransportFrameSchema = z
  .object({
    zcode_type: z.literal("rpc-frame"),
    bridgeSessionId: webRemoteControlRpcTransportIdSchema,
    bridgeGeneration: nonnegativeSafeIntegerSchema.optional(),
    recoveryId: webRemoteControlRpcTransportIdSchema.optional(),
    seq: positiveSafeIntegerSchema,
    messageSeq: positiveSafeIntegerSchema,
    fragmentIndex: z
      .number()
      .int()
      .nonnegative()
      .max(WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxFragments - 1),
    fragmentCount: z
      .number()
      .int()
      .positive()
      .max(WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxFragments),
    messageBytes: z
      .number()
      .int()
      .positive()
      .max(WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxMessageBytes),
    checksum: webRemoteControlRpcTransportChecksumSchema,
    // 先做字符串长度硬闸，再进入 decode/refine，避免恶意超长 base64 先分配 decoded buffer。
    dataBase64: z
      .string()
      .min(4)
      .max(WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxPhysicalFrameBytes)
      .refine(isCanonicalBase64),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.fragmentIndex >= value.fragmentCount) {
      context.addIssue({
        code: "custom",
        path: ["fragmentIndex"],
        message: "fragmentIndex must be smaller than fragmentCount",
      });
    }
    if (value.fragmentCount > value.messageBytes) {
      context.addIssue({
        code: "custom",
        path: ["fragmentCount"],
        message: "non-empty fragments cannot exceed message bytes",
      });
    }
  });
export type WebRemoteControlRpcTransportFramePayload = z.infer<
  typeof webRemoteControlRpcTransportFrameSchema
>;

export const webRemoteControlRpcTransportAckSchema = z
  .object({
    zcode_type: z.literal("rpc-frame-ack"),
    bridgeSessionId: webRemoteControlRpcTransportIdSchema,
    bridgeGeneration: nonnegativeSafeIntegerSchema.optional(),
    recoveryId: webRemoteControlRpcTransportIdSchema.optional(),
    ackMessageSeq: positiveSafeIntegerSchema,
  })
  .strict();
export type WebRemoteControlRpcTransportAckPayload = z.infer<
  typeof webRemoteControlRpcTransportAckSchema
>;

export const webRemoteControlRpcTransportPayloadSchema = z.union([
  webRemoteControlRpcTransportFrameSchema,
  webRemoteControlRpcTransportAckSchema,
]);
export type WebRemoteControlRpcTransportPayload = z.infer<
  typeof webRemoteControlRpcTransportPayloadSchema
>;
