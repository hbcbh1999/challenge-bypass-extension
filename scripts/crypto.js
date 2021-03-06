/*
 * This implements a 2HashDH-based token scheme using the SJCL ecc package.
 *
 * @author: George Tankersley
 */

/*global sjcl*/
/* exported CreateBlindToken */
/* exported checkRequestBinding */
/* exported compressPoint */
/* exported decodeStorablePoint */
/* exported deriveKey */
/* exported encodeStorablePoint */
/* exported sec1DecodePoint */
/* exported signPoint */
/* exported unblindPoint */
/* exported verifyBatchProof */
"use strict";

var p256 = sjcl.ecc.curves.c256;
const P256_NAME = "c256";
const BATCH_PROOF_PREFIX = "batch-proof=";
const NO_COMMITMENTS_ERR = "[privacy-pass]: Batch proof does not contain commitments";
const INCORRECT_POINT_SETS_ERR = "[privacy-pass]: Point sets for batch proof are incorrect";
const COMMITMENT_MISMATCH_ERR = "[privacy-pass]: Mismatch between stored and received commitments";
const DLEQ_PROOF_INCOMPLETE = "[privacy-pass]: DLEQ proof has components that are not defined";
const INCORRECT_CURVE_ERR = "[privacy-pass]: Curve is incorrect for one or more points in proof";
const DIGEST_INEQUALITY_ERR = "[privacy-pass]: Recomputed digest does not equal received digest";
const PARSE_ERR = "[privacy-pass]: Error parsing proof";
const INCONSISTENT_BATCH_PROOF_ERR = "[privacy-pass]: Tokens/signatures are inconsistent with batch proof";
const INCONSISTENT_DLEQ_PROOF_ERR = "[privacy-pass]: Tokens/signatures are inconsistent with underlying DLEQ proof";

let activeCommConfig = ProdCommitmentConfig;

// Performs the scalar multiplication k*P
//
// Inputs:
//  k: bigInt scalar (not field element or bits!)
//  P: sjcl Point
// Returns:
//  sjcl Point
function _scalarMult(k, P) {
    const Q = P.mult(k);
    return Q;
}

// blindPoint generates a random scalar blinding factor, multiplies the
// supplied point by it, and returns both values.
function blindPoint(P) {
    const bF = sjcl.bn.random(p256.r, 10);
    const bP = _scalarMult(bF, P);
    return { point: bP, blind: bF };
}

// unblindPoint takes an assumed-to-be blinded point Q and an accompanying
// blinding scalar b, then returns the point (1/b)*Q.
//
// inputs:
//  b: bigint scalar (not field element or bits!)
//  q: sjcl point
// returns:
//  sjcl point
function unblindPoint(b, Q) {
    const binv = b.inverseMod(p256.r);
    return _scalarMult(binv, Q);
}

// multiplies the point by the secret scalar "key"
//
// inputs:
//  key: bigint scalar (not field element or bits!)
//  P: sjcl point
// returns:
//  sjcl point
function signPoint(key, P) {
    return _scalarMult(key, P);
}

// Derives the shared key used for redemption MACs
//
// Inputs:
//  N: sjcl Point
//  token: bytes
// Returns:
//  bytes
function deriveKey(N, token) {
    // the exact bits of the string "hash_derive_key"
    const tagBits = sjcl.codec.hex.toBits("686173685f6465726976655f6b6579");
    const h = new sjcl.misc.hmac(tagBits, sjcl.hash.sha256);

    const encodedPoint = sec1EncodePoint(N);
    const tokenBits = sjcl.codec.bytes.toBits(token);
    const pointBits = sjcl.codec.bytes.toBits(encodedPoint);

    h.update(tokenBits);
    h.update(pointBits);

    const keyBytes = sjcl.codec.bytes.fromBits(h.digest());
    return keyBytes;
}

// Generates the HMAC used to bind request data to a particular token redemption.
//
// Inputs:
//  key: raw key bytes as returned by deriveKey
//  data: array of data as bytes
// Returns:
//  bytes
function createRequestBinding(key, data) {
    // the exact bits of the string "hash_request_binding"
    const tagBits = sjcl.codec.utf8String.toBits("hash_request_binding");
    const keyBits = sjcl.codec.bytes.toBits(key);

    const h = new sjcl.misc.hmac(keyBits, sjcl.hash.sha256);
    h.update(tagBits);

    let dataBits = null;
    for (var i = 0; i < data.length; i++) {
        dataBits = sjcl.codec.bytes.toBits(data[i]);
        h.update(dataBits);
    }

    const digestBytes = sjcl.codec.bytes.fromBits(h.digest());
    return digestBytes;
}

// Checks an HMAC generated by createRequestBinding
//
// Inputs:
//  key: key bytes as returned by deriveKey
//  data: data bytes
//  mac: bytes of the MAC to check
// Returns:
//  true if valid, false otherwise
function checkRequestBinding(key, data, mac) {
    const macBits = sjcl.codec.bytes.toBits(mac);
    const observedMAC = createRequestBinding(key, data);
    const observedBits = sjcl.codec.bytes.toBits(observedMAC);

    return sjcl.bitArray.equal(macBits, observedBits);
}

// Creates
// Inputs:
//  none
// Returns:
//  token bytes
//  T sjcl point
//  r blinding factor, sjcl bignum
function CreateBlindToken() {
    let t = newRandomPoint();
    let bpt = blindPoint(t.point);
    return { token: t.token, point: bpt.point, blind: bpt.blind };
}

function newRandomPoint() {
    const byteLength = 32;
    const wordLength = byteLength / 4; // SJCL 4 bytes to a word

    // TODO Use webcrypto instead. This is JavaScript Fortuna from 2010.
    var random = sjcl.random.randomWords(wordLength, 10); // paranoia 10
    var point = hashToCurve(random);
    return { token: sjcl.codec.bytes.fromBits(random), point: point};
}

// input: bits
// output: point
function hashToCurve(seed) {
    const h = new sjcl.hash.sha256();

    // Need to match the Go curve hash, so we decode the exact bytes of the
    // string "1.2.840.100045.3.1.7 point generation seed" instead of relying
    // on the utf8 codec that didn't match.
    const separator = sjcl.codec.hex.toBits("312e322e3834302e31303034352e332e312e3720706f696e742067656e65726174696f6e2073656564");

    h.update(separator);

    let i = 0;
    for (i = 0; i < 10; i++) {
        // little endian uint32
        let ctr = new Uint8Array(4);
        // typecast hack: number -> Uint32, bitwise Uint8
        ctr[0] = (i >>> 0) & 0xFF;
        let ctrBits = sjcl.codec.bytes.toBits(ctr);

        // H(s||ctr)
        h.update(seed);
        h.update(ctrBits);

        const digestBits = h.finalize();

        let point = decompressPoint(digestBits, 0x02);
        if (point !== null) {
            return point;
        }

        point = decompressPoint(digestBits, 0x03);
        if (point !== null) {
            return point;
        }

        seed = digestBits;
        h.reset();
    }

    return null;
}

// Attempts to decompress the bytes into a curve point following SEC1 and
// assuming it's a Weierstrass curve with a = -3 and p = 3 mod 4 (true for the
// main three NIST curves).
// input: bits of an x coordinate, the even/odd tag
// output: point
function decompressPoint(xbits, tag) {
    const x = p256.field.fromBits(xbits).normalize();
    const sign = tag & 1;

    // y^2 = x^3 - 3x + b (mod p)
    let rh = x.power(3);
    let threeTimesX = x.mul(3);
    rh = rh.sub(threeTimesX).add(p256.b).mod(p256.field.modulus); // mod() normalizes

    // modsqrt(z) for p = 3 mod 4 is z^(p+1/4)
    const sqrt = p256.field.modulus.add(1).normalize().halveM().halveM();
    let y = rh.powermod(sqrt, p256.field.modulus);

    let parity = y.limbs[0] & 1;

    if (parity != sign) {
        y = p256.field.modulus.sub(y).normalize();
    }

    let point = new sjcl.ecc.point(p256, x, y);
    if (!point.isValid()) {
        return null;
    }
    return point;
}

// Compresses a point according to SEC1.
// input: point
// output: base64-encoded bytes
function compressPoint(p) {
    const xBytes = sjcl.codec.bytes.fromBits(p.x.toBits());
    const sign = p.y.limbs[0] & 1 ? 0x03 : 0x02;
    const taggedBytes = [sign].concat(xBytes);
    return sjcl.codec.base64.fromBits(sjcl.codec.bytes.toBits(taggedBytes));
}

// This has to match Go's elliptic.Marshal, which follows SEC1 2.3.3 for
// uncompressed points.  SJCL's native point encoding is a concatenation of the
// x and y coordinates, so it's *almost* SEC1 but lacks the tag for
// uncompressed point encoding.
//
// Inputs:
//  P: sjcl Point
// Returns:
//  bytes
function sec1EncodePoint(P) {
    const pointBits = P.toBits();
    const xyBytes = sjcl.codec.bytes.fromBits(pointBits);
    return [0x04].concat(xyBytes);
}

// input: base64-encoded bytes
// output: point
function sec1DecodePoint(p) {
    const sec1Bits = sjcl.codec.base64.toBits(p);
    const sec1Bytes = sjcl.codec.bytes.fromBits(sec1Bits);
    if (sec1Bytes[0] != 0x04) {
        throw new Error("[privacy-pass]: attempted sec1DecodePoint with incorrect tag: " + p);
    }
    const coordinates = sec1Bytes.slice(1); // remove "uncompressed" tag
    const pointBits = sjcl.codec.bytes.toBits(coordinates);
    return p256.fromBits(pointBits);
}

// Marshals a point in an SJCL-internal format that can be used with
// JSON.stringify for localStorage.
//
// input: point
// output: base64 string
function encodeStorablePoint(p) {
    const bits = p.toBits();
    return sjcl.codec.base64.fromBits(bits);
}

// Renders a point from SJCL-internal base64.
//
// input: base64 string
// ouput: point
function decodeStorablePoint(s) {
    const bits = sjcl.codec.base64.toBits(s);
    return p256.fromBits(bits);
}


/**
 * DLEQ proof verification logic
 */

// Verifies the DLEQ proof that is returned when tokens are signed
// 
// input: marshaled JSON DLEQ proof
// output: bool
function verifyBatchProof(proof, tokens, signatures) {
    let batchProofM = getMarshaledBatchProof(proof);
    let bp = unmarshalBatchProof(batchProofM);
    if (!bp) {
        // Error has probably occurred
        return false;
    }
    const chkM = tokens;
    const chkZ = signatures;
    if (!isBatchProofCompleteAndSane(bp, chkM, chkZ)) {
        return false;
    }
    return verifyDleq(bp, chkM, chkZ);
}

// Verify the NIZK DLEQ proof
function verifyDleq(bp, chkM, chkZ) {
    // Check sanity of proof
    let dleq = bp.P;
    if (!isDleqCompleteAndSane(dleq, chkM, chkZ, bp.C)) {
        return false;
    }

    let cH = _scalarMult(dleq.C, dleq.H);
    let rG = _scalarMult(dleq.R, dleq.G);
    const A = cH.toJac().add(rG).toAffine();

    let cZ = _scalarMult(dleq.C, dleq.Z);
    let rM = _scalarMult(dleq.R, dleq.M);
    const B = cZ.toJac().add(rM).toAffine();

    // Recalculate C' and check if C =?= C'
    let h = new sjcl.hash.sha256();
    h.update(sjcl.codec.bytes.toBits(sec1EncodePoint(dleq.G)));
    h.update(sjcl.codec.bytes.toBits(sec1EncodePoint(dleq.H)));
    h.update(sjcl.codec.bytes.toBits(sec1EncodePoint(dleq.M)));
    h.update(sjcl.codec.bytes.toBits(sec1EncodePoint(dleq.Z)));
    h.update(sjcl.codec.bytes.toBits(sec1EncodePoint(A)));
    h.update(sjcl.codec.bytes.toBits(sec1EncodePoint(B)));
    const digestBits = h.finalize();
    const receivedDigestBits = dleq.C.toBits();
    if (!sjcl.bitArray.equal(digestBits, receivedDigestBits)) {
        console.error(DIGEST_INEQUALITY_ERR);
        console.error("Computed digest: " + digestBits.toString());
        console.error("Received digest: " + receivedDigestBits.toString());
        return false;
    }
    return true;
}

// Check that the underlying DLEQ proof is well-defined
function isDleqCompleteAndSane(dleq, chkM, chkZ, proofC) {
    if (!dleq.M || !dleq.Z || !dleq.R || !dleq.C) {
        console.error(DLEQ_PROOF_INCOMPLETE);
        return false;
    }

    // Check that all points are on the same curve
    let curveG = dleq.G.curve;
    let curveH = dleq.H.curve;
    let curveM = dleq.M.curve;
    let curveZ = dleq.Z.curve;
    if (sjcl.ecc.curveName(curveG) != sjcl.ecc.curveName(curveH) ||
        sjcl.ecc.curveName(curveH) != sjcl.ecc.curveName(curveM) ||
        sjcl.ecc.curveName(curveM) != sjcl.ecc.curveName(curveZ) ||
        sjcl.ecc.curveName(curveG) != P256_NAME) {
        console.error(INCORRECT_CURVE_ERR);
        return false;
    }

    let chkMPoint;
    let chkZPoint;
    for (let i=0; i<chkM.length; i++) {
        let cMi = _scalarMult(proofC[i], chkM[i].point);
        let cZi = _scalarMult(proofC[i], chkZ[i]);

        if (!chkMPoint && !chkZPoint) {
            chkMPoint = cMi;
            chkZPoint = cZi;
        } else {
            chkMPoint = chkMPoint.toJac().add(cMi).toAffine();
            chkZPoint = chkZPoint.toJac().add(cZi).toAffine();
        }
    }
    if (!sjcl.bitArray.equal(dleq.M.toBits(), chkMPoint.toBits()) || !sjcl.bitArray.equal(dleq.Z.toBits(), chkZPoint.toBits())) {
        console.error(INCONSISTENT_DLEQ_PROOF_ERR);
        return false;
    }
    return true;
}

// Checks that the batch proof is well-defined
function isBatchProofCompleteAndSane(bp, chkM, chkZ) {
    // Check commitments are present
    let G = bp.P.G;
    let H = bp.P.H;
    if (!G || !H) {
        console.error(NO_COMMITMENTS_ERR);
        return false;
    }
    // Check that point sets are present and correct
    let lenM = bp.M.length;
    let lenZ = bp.Z.length;
    if (!bp.M || !bp.Z || lenM == 0 || lenZ == 0 || lenM !== lenZ || chkM.length !== lenM || chkZ.length !== lenZ) {
        console.error(INCORRECT_POINT_SETS_ERR);
        return false;
    }
    // Check that the curve is correct and that the values of M, Z are consistent
    for (let i=0; i<lenM; i++) {
        if (sjcl.ecc.curveName(bp.M[i].curve) != sjcl.ecc.curveName(G.curve) ||
            sjcl.ecc.curveName(bp.Z[i].curve) != sjcl.ecc.curveName(G.curve) ||
            sjcl.ecc.curveName(bp.M[i].curve) != P256_NAME) {
            console.error(INCORRECT_CURVE_ERR);
            return false;
        }
        // If the values of M and Z are consistent then we can use dleq.M and 
        // dleq.Z to verify the proof later
        if (!sjcl.bitArray.equal(bp.M[i].toBits(), chkM[i].point.toBits()) ||
            !sjcl.bitArray.equal(bp.Z[i].toBits(), chkZ[i].toBits())) {
            console.error(INCONSISTENT_BATCH_PROOF_ERR);
            return false;
        }
    }

    // [TODO]: Recompute the PRNG state using knowledge of the tokens that are received.
    // Verification is not complete until this is done.
    
    return true;
}

// Returns a decoded batch proof as a map
function unmarshalBatchProof(batchProofM) {
    let bp = new Map();
    let dleqProof;
    try {
        dleqProof = parseDleqProof(atob(batchProofM.P));
    } catch(e) {
        console.error(PARSE_ERR);
        return;
    }

    bp.P = dleqProof;
    bp.M = batchDecodePoints(batchProofM.M);
    bp.Z = batchDecodePoints(batchProofM.Z);
    let encC = batchProofM.C;
    let decC = [];
    for (let i=0; i<encC.length; i++) {
        decC[i] = getBigNumFromB64(encC[i]);
    }
    bp.C = decC;

    return bp;
}

// Batch decode a number of points
// 
// input: Array of sec1-encoded points
// output: Array of sec1-decoded points
function batchDecodePoints(pointArr) {
    let decPointArr = [];
    for (let i=0; i<pointArr.length; i++) {
        decPointArr.push(sec1DecodePoint(pointArr[i]));
    }
    return decPointArr;
}

// Decode proof string and remove prefix
function getMarshaledBatchProof(proof) {
    let proofStr = atob(proof);
    if (proofStr.indexOf(BATCH_PROOF_PREFIX) === 0) {
        proofStr = proofStr.substring(BATCH_PROOF_PREFIX.length);
    }
    return JSON.parse(proofStr);
}

// Decode the proof that is sent into a map
// 
// input: Marshaled proof string
// output: DLEQ proof
function parseDleqProof(proofStr) {
    const dleqProofM = JSON.parse(proofStr);
    let dleqProof = new Map();

    // if we do not have the same commitments then something is wrong
    if (!validateConsistentCommitments(dleqProofM.G, dleqProofM.H)) {
        throw new Error(COMMITMENT_MISMATCH_ERR);
    }

    dleqProof.G = sec1DecodePoint(dleqProofM.G);
    dleqProof.M = sec1DecodePoint(dleqProofM.M);
    dleqProof.H = sec1DecodePoint(dleqProofM.H);
    dleqProof.Z = sec1DecodePoint(dleqProofM.Z);
    dleqProof.R = getBigNumFromB64(dleqProofM.R);
    dleqProof.C = getBigNumFromB64(dleqProofM.C);
    return dleqProof;
}

// Check that the commitments on the proof match the commitments
// in the extension
function validateConsistentCommitments(G,H) {
    if (G != activeCommConfig.G || H != activeCommConfig.H) {
        return false;
    }
    return true;
}

// Return a byte array from a base-64 encoded string
function getBigNumFromB64(b64Str) {
    let bits = sjcl.codec.base64.toBits(b64Str)
    return sjcl.bn.fromBits(bits);
}
