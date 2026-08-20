export function createCreditFeatureRegistry(featureDefinitions = {}) {
  const features = Object.freeze({ ...featureDefinitions });
  return {
    getFeaturePolicy(featureKey) {
      return features[String(featureKey || '').trim()] || null;
    },
    listFeatures() {
      return Object.values(features);
    },
    hasFeature(featureKey) {
      return Object.prototype.hasOwnProperty.call(features, String(featureKey || '').trim());
    },
  };
}
