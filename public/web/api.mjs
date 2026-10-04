// Web implementation of the existing API's core annotation contract.
export class WebAPI {
  constructor(workspace) { this.workspace = workspace; this.capabilities = { accounts: false, collaborators: false, automation: false, annotations: true, review: true, immutableVersions: true }; }
  async getMe() { return { id: this.workspace.manifest.id, username: 'Workspace owner' }; }
  async logout() { return this.workspace.disconnect(); }
  async getProjects() { return this.workspace.list('project').map(({id,value})=>({ ...value,id })); }
  async createProject(name, description = '') { const id = crypto.randomUUID(); const project = { id, name: String(name), description: String(description), labels: [], createdAt: new Date().toISOString() }; await this.workspace.put('project',id,project); return project; }
  async getProject(id) { return this.workspace.get('project',id); }
  async updateProject(id, data) { const project = this.workspace.get('project',id); if (!project) throw new Error('Project not found'); const next = { ...project,...data,id }; await this.workspace.put('project',id,next);return next; }
  async deleteProject(id) { await this.workspace.put('project',id,null); }
  async getImages(projectId) { return this.workspace.list('image').map(({id,value})=>({...value,id})).filter(v=>v.projectId===projectId); }
  async getAllImages() { return this.workspace.list('image').map(({id,value})=>({...value,id})); }
  async uploadImages(projectId, files, options={}) {
    if (!this.workspace.get('project',projectId)) throw new Error('Project not found'); const images=[];
    for (const file of files) {
      if (!['image/png','image/jpeg','image/webp','image/bmp','image/gif'].includes(file.type) || file.size>32*1024*1024) throw new Error('Choose a supported raster image under 32 MiB');
      // Decode in the browser before storing; MIME alone is not validation.
      if (globalThis.createImageBitmap) { const bitmap=await createImageBitmap(file); if (bitmap.width*bitmap.height>100_000_000) {bitmap.close();throw new Error('Image dimensions exceed the limit');} bitmap.close(); }
      const id=crypto.randomUUID();const asset=await this.workspace.manageAsset(file,options);const image={id,projectId,originalName:file.name,asset,createdAt:new Date().toISOString()};await this.workspace.put('image',id,image);images.push(image);
    }
    return images;
  }
  async linkImage(projectId,ref) { if(!this.workspace.get('project',projectId))throw new Error('Project not found');if(!['image/png','image/jpeg','image/webp','image/bmp','image/gif'].includes(ref.mimeType))throw new Error('Link a supported raster image');if(ref.size>32*1024*1024)throw new Error('Linked image exceeds display limit');const image={id:crypto.randomUUID(),projectId,originalName:ref.name,asset:{mode:'linked',provider:this.workspace.provider.name,id:ref.id,revision:ref.revision,size:ref.size,mimeType:ref.mimeType}};await this.workspace.put('image',image.id,image);return image; }
  async imageBlob(id) { const image=this.workspace.get('image',id);if(!image)throw new Error('Image not found');if(image.asset.size>32*1024*1024)throw new Error('Image exceeds display limit');const chunks=[];let size=0;for await(const chunk of this.workspace.readAsset(image.asset)){size+=chunk.byteLength;if(size>32*1024*1024)throw new Error('Decoded image exceeds the 32 MiB display limit');chunks.push(chunk);}return new Blob(chunks,{type:image.asset.mimeType}); }
  async deleteImage(id) { await this.workspace.put('image',id,null); }
  async getAnnotations(imageId) { return this.workspace.get('annotation',imageId)||[]; }
  async saveAnnotations(imageId,shapes,metadata={}) { if(!this.workspace.get('image',imageId))throw new Error('Image not found');const snapshot=structuredClone(shapes);await this.workspace.put('annotation',imageId,snapshot,metadata);return snapshot; }
  async getAnnotationRevisions(imageId) { return this.workspace.history('annotation',imageId); }
  async restoreAnnotationRevision(imageId,revisionId) { return this.workspace.restore('annotation',imageId,revisionId); }
  async getImageReview(imageId) { return this.workspace.get('review',imageId)||{status:'draft',comments:[]}; }
  async updateImageReview(imageId,changes) { const value={...await this.getImageReview(imageId),...changes};await this.workspace.put('review',imageId,value);return value; }
  async addReviewComment(imageId,message) { const value=await this.getImageReview(imageId);value.comments=[...value.comments,{id:crypto.randomUUID(),message:String(message),createdAt:new Date().toISOString()}];return this.updateImageReview(imageId,value); }
  async getModels(projectId) { return this.workspace.list('model').map(({id,value})=>({...value,id})).filter(m=>m.projectId===projectId); }
  async uploadModel(projectId,file,options={}) { if(!/\.onnx$/i.test(file.name))throw new Error('Web companion accepts ONNX only; arbitrary PyTorch files are unsafe');if(file.size>32*1024*1024)throw new Error('Companion model limit is 32 MiB');const model={id:crypto.randomUUID(),projectId,name:file.name,asset:await this.workspace.manageAsset(file,options)};await this.workspace.put('model',model.id,model);return model; }
  async createVersion(projectId) { const images=await this.getImages(projectId);const snapshot={project:await this.getProject(projectId),images:await Promise.all(images.map(async image=>({...image,annotations:await this.getAnnotations(image.id),review:await this.getImageReview(image.id)}))),createdAt:new Date().toISOString()};const id=crypto.randomUUID();await this.workspace.put('version',id,snapshot);return {id,...snapshot}; }
  async saveSession(state) { const previous=this.workspace.list('session')[0];await this.workspace.put('session',previous?.id||crypto.randomUUID(),state); }
  async restoreSession() { return this.workspace.list('session')[0]?.value||null; }
  unsupported(feature) { throw new Error(`${feature} requires the self-hosted runtime or provider-controlled sharing`); }
}
