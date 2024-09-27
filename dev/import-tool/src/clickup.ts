import {
  type AttachedData,
  collaborativeDocParse,
  generateId,
  makeCollaborativeDoc,
  type Ref,
  type TxOperations
} from '@hcengineering/core'
import { type FileUploader } from './fileUploader'
import document, { type Document, type Teamspace } from '@hcengineering/document'
import { jsonToYDocNoSchema, parseMessageMarkdown } from '@hcengineering/text'
import { yDocToBuffer } from '@hcengineering/collaboration'
import { readdir, readFile } from 'fs/promises'
import { join, parse } from 'path'
import { error } from 'console'

type ClickupId = string
type HulyId = string

interface FileMetadata {
  fullPath: string
  extension: string
}

interface DocumentMetadata {
  id: HulyId
  clickupId: ClickupId
  name: string
}

type FileMetadataMap = Map<ClickupId, FileMetadata>
type DocumentMetadataMap = Map<HulyId, DocumentMetadata>

export async function importClickUp (
  client: TxOperations,
  uploadFile: FileUploader,
  dir: string,
  teamspace: Ref<Teamspace>
): Promise<void> {
  const files = await readdir(dir, { recursive: true })
  console.log(files)

  for (const file of files) {
    const parsedFileName = parse(file)
    const extension = parsedFileName.ext.toLowerCase()
    const fullPath = join(dir, file)
    const data = await readFile(fullPath)
    if (extension === '.md') {
      await importPageDocument(client, uploadFile, parsedFileName.name, data, teamspace)
    } else if (extension === '.csv') {

    }
  }
}

// async function collectFilesMetadata (
//   files: Dirent[],
//   fileMetaMap: FileMetadataMap,
//   documentMetaMap: DocumentMetadataMap
// ): Promise<void> {
//   for (const file of files) {
//     const clickupId = extractClickupId(file.name)
//     // fileMetaMap.set(clickupId, {
//     //   filePath: join(file.path, file.name),
//     //   extension: parse(file.name).ext.toLowerCase()
//     // })
//     // await collectFileMetadata(file, fileMetaMap, documentMetaMap)
//   }
// }

async function importPageDocument (
  client: TxOperations,
  uploadFile: FileUploader,
  name: string,
  data: Buffer,
  space: Ref<Teamspace>
): Promise<void> {
  const md = data.toString() ?? ''
  const json = parseMessageMarkdown(md ?? '', 'image://')

  const id = generateId<Document>()
  const collabId = makeCollaborativeDoc(id, 'content')
  const yDoc = jsonToYDocNoSchema(json, 'content')
  const { documentId } = collaborativeDocParse(collabId)
  const buffer = yDocToBuffer(yDoc)

  const form = new FormData()
  const file = new File([new Blob([buffer])], name)
  form.append('file', file, documentId)
  form.append('type', 'application/ydoc')
  form.append('size', buffer.length.toString())
  form.append('name', name)
  form.append('id', id)
  form.append('data', new Blob([buffer])) // ?

  await uploadFile(id, form)

  const attachedData: AttachedData<Document> = {
    name,
    content: collabId,
    attachments: 0,
    children: 0,
    embeddings: 0,
    labels: 0,
    comments: 0,
    references: 0
  }

  await client.addCollection(
    document.class.Document,
    space,
    document.ids.NoParent,
    document.class.Document,
    'children',
    attachedData,
    id
  )
}

async function importIssue() {
    
}