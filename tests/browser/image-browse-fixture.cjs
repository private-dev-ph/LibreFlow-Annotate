const { browseProjectImages } = require('../../lib/project-image-browser');

module.exports = function imagePage(route, images) {
  const query = Object.fromEntries(new URL(route.request().url()).searchParams);
  return browseProjectImages({ query, batches: [], images: images.map(image => ({ projectId: query.projectId, ...image })) });
};
