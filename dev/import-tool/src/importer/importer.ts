import attachment, { attachmentId } from '@hcengineering/attachment'
import {
  Account,
  AttachedData,
  type CollaborativeDoc,
  collaborativeDocParse,
  generateId,
  makeCollaborativeDoc,
  type Ref,
  SortingOrder,
  type Status,
  Timestamp,
  type TxOperations,
  type Blob as PlatformBlob
} from '@hcengineering/core'
import { type Person } from '@hcengineering/contact'
import tracker, { type Issue, type IssuePriority, type Project } from '@hcengineering/tracker'
import type { FileUploader } from '../fileUploader'
import document from '@hcengineering/document'
import core from '@hcengineering/model-core'
import task, { makeRank, type TaskType } from '@hcengineering/task'
import { jsonToYDocNoSchema, parseMessageMarkdown } from '@hcengineering/text'
import { yDocToBuffer } from '@hcengineering/collaboration'
import chunter, { ChatMessage } from '@hcengineering/chunter'

import { readdir, stat, readFile } from 'fs/promises'
import { writeFileSync } from 'fs'

export interface ImportTaskType {
  name: string
  statuses: string[]
}

export interface ImportProjectType {
  name: string
  taskTypes: ImportTaskType[]
}

export interface ImportPerson {
  name: string
  email: string
}

export interface ImportComment {
  text: string
  author?: Ref<Account> // todo: person vs account
  date?: Timestamp
  attachments: ImportAttachment[]
}

export interface ImportAttachment {
  title: string
  blob: Blob
}

export interface ImportIssue {
  title: string
  description: string
  assignee: Ref<Person> | null
  status: Ref<Status>
  priority: IssuePriority
  estimation: number
  remainingTime: number
  comments: ImportComment[]
  collaborators?: Ref<Person>[]
}

export async function importIssue (
  client: TxOperations,
  uploadFile: FileUploader,
  id: Ref<Issue>,
  data: ImportIssue,
  space: Ref<Project>
): Promise<void> {
  const lastOne = await client.findOne<Issue>(
    tracker.class.Issue,
    { space },
    { sort: { rank: SortingOrder.Descending } }
  )
  const incResult = await client.updateDoc(
    tracker.class.Project,
    core.space.Space,
    space,
    {
      $inc: { sequence: 1 }
    },
    true
  )

  const proj = await client.findOne(tracker.class.Project, { _id: space })
  const number = (incResult as any).object.sequence
  const identifier = `${proj?.identifier}-${number}`

  const taskKind = proj?.type !== undefined ? { parent: proj.type } : {}
  const kind = (await client.findOne(task.class.TaskType, taskKind)) as TaskType

  const collabId = await importIssueDescription(uploadFile, id, data.description)

  const taskToCreate = {
    title: data.title,
    description: collabId,
    assignee: data.assignee,
    component: null,
    number,
    status: data.status,
    priority: data.priority,
    rank: makeRank(lastOne?.rank, undefined),
    comments: data.comments.length,
    subIssues: 0, // todo
    dueDate: null,
    parents: [], // todo
    reportedTime: 0,
    remainingTime: data.remainingTime,
    estimation: data.estimation,
    reports: 0,
    childInfo: [],
    identifier,
    kind: kind._id
  }
  await client.addCollection(
    tracker.class.Issue,
    space,
    tracker.ids.NoParent,
    tracker.class.Issue,
    'subIssues',
    taskToCreate,
    id
  )

  for (const comment of data.comments) {
    await importComment(client, uploadFile, id, comment, space)
  }
}

async function importIssueDescription (
  uploadFile: FileUploader,
  id: Ref<Issue>,
  data: string
): Promise<CollaborativeDoc> {
  const json = parseMessageMarkdown(data ?? '', 'image://')
  const collabId = makeCollaborativeDoc(id, 'description')

  const yDoc = jsonToYDocNoSchema(json, 'description')
  const { documentId } = collaborativeDocParse(collabId)
  const buffer = yDocToBuffer(yDoc)

  const form = new FormData()
  const file = new File([new Blob([buffer])], collabId)
  form.append('file', file, documentId)
  form.append('type', 'application/ydoc')
  form.append('size', buffer.length.toString())
  form.append('name', collabId)
  form.append('id', id)
  form.append('data', new Blob([buffer])) // ?

  await uploadFile(id, form)

  return collabId
}

export async function importComment (
  client: TxOperations,
  uploadFile: FileUploader,
  issueId: Ref<Issue>,
  data: ImportComment,
  space: Ref<Project>
): Promise<void> {
  const commentId = generateId<ChatMessage>()
  const value: AttachedData<ChatMessage> = {
    message: data.text,
    attachments: data.attachments?.length
  }
  await client.addCollection(
    chunter.class.ChatMessage,
    space,
    issueId,
    tracker.class.Issue,
    'comments',
    value,
    commentId,
    // new Date(data.created_at).getTime(),
    data.date,
    data.author
  )

  for (const attach of data.attachments) {
    const form = new FormData()
    const file = new File([attach.blob], attach.title)
    form.append('file', file)
    form.append('type', file.type)
    form.append('size', file.size.toString())
    form.append('name', attach.title)
    const attachmentId = generateId()
    form.append('id', attachmentId)
    form.append('data', attach.blob) // ?

    await uploadFile(attachmentId, form)
    
    const attachValue = {
        _id: attachmentId,
        _class: attachment.class.Attachment,
        attachedTo: commentId,
        attachedToClass: chunter.class.ChatMessage,
        collection: 'attachments',
      file: '' as Ref<PlatformBlob>,
      lastModified: Date.now(),
      name: file.name,
      size: file.size,
      space: space,
      type: 'file'
    }

    const data = new FormData()
    data.append('file', new File([attach.blob], attach.title))
    
    // await client.createDoc(document.class.Document, space, attachValue, attachmentId)
  }
}

// const file = new File([attach.blob], attach.title)
// writeFileSync(`kitten.jpg`, new Uint8Array(await file.arrayBuffer()))
