export type CreatedOffer = {
    type: 'offer_created',
    sdp: RTCSessionDescriptionInit
}

export type FoundICECandidate = {
    type: 'candidate',
    candidate: RTCIceCandidate
}