export const DEFAULT_CONDITION = 'Very Good+';
export const CONDITION_DESCRIPTIONS = Object.freeze({
  Mint: 'Pristine. Nearly silent surface with virtually no audible wear.',
  'Near Mint': 'Extremely clean. Faint surface texture with only occasional tiny imperfections.',
  'Very Good+': 'Clean but played. Light vinyl texture with occasional clicks and subtle crackle.',
  'Very Good': 'Clearly used. Audible surface noise, regular crackle and mild groove wear.',
  Fair: 'Heavily played. Frequent crackle and pops with noticeable loss of clarity.',
  Poor: 'Worn hard. Dense crackle, frequent pops and obvious groove wear.',
});

/** One ordered condition catalog for audible degradation and physical wear. */
export const CONDITIONS = Object.freeze({
  Mint: {
    surfaceNoise: .00012, noiseColor: .1, crackleDensity: .025, crackleGain: .0008,
    popRate: .006, popGain: .004, transientVariation: .1,
    wearAmount: 0, highFrequencyLoss: 0, saturation: 0, stereoNarrowing: 0, visualWear: 0,
  },
  'Near Mint': {
    surfaceNoise: .0005, noiseColor: .16, crackleDensity: .18, crackleGain: .002,
    popRate: .035, popGain: .009, transientVariation: .2,
    wearAmount: .003, highFrequencyLoss: .08, saturation: .001, stereoNarrowing: .002, visualWear: .025,
  },
  'Very Good+': {
    surfaceNoise: .0024, noiseColor: .24, crackleDensity: 1.4, crackleGain: .006,
    popRate: .17, popGain: .025, transientVariation: .35,
    wearAmount: .025, highFrequencyLoss: .45, saturation: .008, stereoNarrowing: .008, visualWear: .07,
  },
  'Very Good': {
    surfaceNoise: .007, noiseColor: .36, crackleDensity: 6, crackleGain: .015,
    popRate: .75, popGain: .055, transientVariation: .5,
    wearAmount: .08, highFrequencyLoss: 2, saturation: .045, stereoNarrowing: .03, visualWear: .15,
  },
  Fair: {
    surfaceNoise: .019, noiseColor: .5, crackleDensity: 14, crackleGain: .03,
    popRate: 1.8, popGain: .09, transientVariation: .7,
    wearAmount: .2, highFrequencyLoss: 4.5, saturation: .14, stereoNarrowing: .09, visualWear: .28,
  },
  Poor: {
    surfaceNoise: .038, noiseColor: .65, crackleDensity: 30, crackleGain: .05,
    popRate: 3.4, popGain: .15, transientVariation: 1,
    wearAmount: .34, highFrequencyLoss: 8, saturation: .32, stereoNarrowing: .18, visualWear: .44,
  },
});
for (const profile of Object.values(CONDITIONS)) Object.freeze(profile);
