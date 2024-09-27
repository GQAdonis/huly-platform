import {
  type AttachedData,
  collaborativeDocParse,
  generateId,
  makeCollaborativeDoc,
  type Ref,
  SortingOrder,
  type Status,
  type TxOperations
} from '@hcengineering/core'
import { type FileUploader } from './fileUploader'
import document, { type Document, type Teamspace } from '@hcengineering/document'
import tracker, { IssuePriority, type Issue, type Project } from '@hcengineering/tracker'
import { jsonToYDocNoSchema, parseMessageMarkdown } from '@hcengineering/text'
import { yDocToBuffer } from '@hcengineering/collaboration'
import { readdir, readFile } from 'fs/promises'
import { join, parse } from 'path'
import csv from 'csvtojson'
import core from '@hcengineering/model-core'
import { makeRank } from '@hcengineering/rank'
import task, { type TaskType } from '@hcengineering/task'

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

interface ClickupTask {
  'Task ID': string
  'Task Name': string
  'Task Content': string
  'Status': string
  'Parent ID': string
  'Attachments': string[]
  'Assignees': string[]
  'Comments': string // todo: obj
  'Time Estimated': number
}

interface HulyIssue {
  'title': string
  'description': string
  'status': Ref<Status>
  'estimation': number
}

const StatusMap = new Map <string, Ref<Status>>()
StatusMap.set('выполнено', tracker.status.Done)

const DEFAULT_PROJECT_FIXME = '66f67c4da0935ea73e985ba4' as Ref<Project>

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
    if (extension === '.md') {
      const data = await readFile(fullPath)
      await importPageDocument(client, uploadFile, parsedFileName.name, data, teamspace)
    } else if (extension === '.csv') {
      const jsonArray = await csv().fromFile(fullPath)
      console.log(jsonArray)
      for (const json of jsonArray) {
        const clickupTask = json as ClickupTask
        console.log(clickupTask)
        const issue = convertClickupToHullyIssue(clickupTask)
        console.log(issue)

        await importIssue(client, uploadFile, issue, DEFAULT_PROJECT_FIXME)
        console.log(issue)
      }
    }
  }
}

function convertClickupToHullyIssue (task: ClickupTask): HulyIssue {
  return {
    title: '[' + task['Task ID'] + '] ' + task['Task Name'],
    description: task['Task Content'],
    status: StatusMap.get(task.Status) ?? tracker.status.Backlog,
    estimation: task['Time Estimated']
  }
}

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

async function importIssue (
  client: TxOperations,
  uploadFile: FileUploader,
  data: HulyIssue,
  space: Ref<Project>
): Promise<void> {
  const id: Ref<Issue> = generateId()
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

  const taskToCreate = {
    title: data.title,
    description: makeCollaborativeDoc(id, 'description'),
    assignee: null,
    component: null,
    number,
    status: data.status,
    priority: IssuePriority.NoPriority,
    rank: makeRank(lastOne?.rank, undefined),
    comments: 0,
    subIssues: 0,
    dueDate: null,
    parents: [],
    reportedTime: 0,
    remainingTime: 0,
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
}
