import {
  type AnyAttribute,
  type AttachedData, type Class, ClassifierKind,
  type CollaborativeDoc,
  collaborativeDocParse, type Data, type Doc,
  generateId, Hyperlink,
  makeCollaborativeDoc,
  type Ref,
  SortingOrder,
  type Status,
  type TxOperations
} from '@hcengineering/core'
import { type FileUploader } from './fileUploader'
import document, { type Document, type Teamspace } from '@hcengineering/document'
import tracker from '@hcengineering/tracker'
import pluginState, { type Issue, IssuePriority, type Project } from '@hcengineering/tracker'
import { jsonToYDocNoSchema, parseMessageMarkdown } from '@hcengineering/text'
import { yDocToBuffer } from '@hcengineering/collaboration'
import { readdir, readFile } from 'fs/promises'
import { join, parse } from 'path'
import csv from 'csvtojson'
import core from '@hcengineering/model-core'
import { makeRank } from '@hcengineering/rank'
import task, { createProjectType, type ProjectType, type TaskType, type Task } from '@hcengineering/task'
import { getEmbeddedLabel } from '@hcengineering/platform'

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

const CLICKUP_PROJECT_TYPE_ID = '66f93d911c6b497d54ad5675' as Ref<ProjectType>
const CLICKUP_TASK_TYPE_ID = '66fbf115093abbaab6dd54b7' as Ref<TaskType>

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
      await processClickupDocument(fullPath, client, uploadFile, parsedFileName.name, teamspace)
    } else if (extension === '.csv') {
      await processClickupTasks(fullPath, client, uploadFile)
    }
  }
}

async function processClickupDocument (
  fullPath: string,
  client: TxOperations,
  uploadFile: (id: string, data: any) => Promise<any>,
  docName: string,
  teamspace: string & {
    __ref: Teamspace
  }
) {
  const data = await readFile(fullPath)
  await importPageDocument(client, uploadFile, docName, data, teamspace)
}

async function processClickupTasks (
  fullPath: string,
  client: TxOperations,
  uploadFile: (id: string, data: any) => Promise<any>
): Promise<void> {
  const jsonArray = await csv().fromFile(fullPath)
  console.log(jsonArray)

  const statuses: string[] = []
  for (const json of jsonArray) {
    const clickupTask = json as ClickupTask

    statuses.push(clickupTask.Status)

    console.log(clickupTask)
    const issue = convertClickupToHullyIssue(clickupTask)
    console.log(issue)

    // await importIssue(client, uploadFile, issue, DEFAULT_PROJECT_FIXME)
    // console.log(issue)
  }
  console.log(statuses)
  console.log(statuses)

  await createClickUpProjectType(client, statuses)
}

function convertClickupToHullyIssue (task: ClickupTask): HulyIssue {
  return {
    title: '[' + task['Task ID'] + '] ' + task['Task Name'],
    description: task['Task Content'],
    status: StatusMap.get(task.Status) ?? tracker.status.Backlog,
    estimation: task['Time Estimated'] ?? 0
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

  const collabId = await importIssueDescription(uploadFile, id, data.description)

  const taskToCreate = {
    title: data.title,
    description: collabId,
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

export interface ClickupIssue extends Issue {
  clickupId: string
}

async function createSimpleAttribute (
  client: TxOperations,
  defaultValue: string,
  mixinClass: Ref<Class<Doc>>
): Promise<void> {
  const data: Data<AnyAttribute> = {
    attributeOf: mixinClass,
    name: 'ClickUp ID',
    label: 'ClickUp ID',
    isCustom: true,
    type: {
      _class: core.class.TypeString,
      label: 'ClickUp ID'
    },
    defaultValue
  }
  // Create new attribute
  await client.createDoc(
    core.class.Attribute,
    core.space.Model,
    data,
    undefined
  )
}

export async function createClickUpProjectType (
  client: TxOperations,
  statuses: string[]
): Promise<void> {
  // Create target class for custom field.
  // NOTE: it is important for this id to be consistent when re-creating the same
  // task type with the same id as it will happen during every migration if type is created by the system
  // const targetClassId = `${CLICKUP_TASK_TYPE_ID}:type:mixin` as Ref<Class<Task>>
  // const ofClassClass = client.getHierarchy().getClass(tracker.class.Issue)
  //
  // const mixinId = await client.createDoc(
  //   core.class.Mixin,
  //   core.space.Model,
  //   {
  //     extends: tracker.class.Issue, // ClickupIssue
  //     kind: ClassifierKind.MIXIN,
  //     label: ofClassClass.label,
  //     icon: ofClassClass.icon,
  //     hidden: false
  //   },
  //   targetClassId
  // )
  //
  // await client.createMixin(
  //   targetClassId,
  //   core.class.Mixin,
  //   core.space.Model,
  //   task.mixin.TaskTypeClass, {
  //     taskType: CLICKUP_TASK_TYPE_ID,
  //     projectType: CLICKUP_PROJECT_TYPE_ID
  //   })
  //
  // if (!client.getHierarchy().hasMixin(projectInst, github.mixin.GithubProject)) {
  //   // We need to add GithubProject mixin
  //   const mixinId = await client.createDoc(core.class.Mixin, core.space.Model, {
  //     extends: github.mixin.GithubIssue,
  //     kind: ClassifierKind.MIXIN,
  //     label: getEmbeddedLabel(projectInst.name),
  //     hidden: false,
  //     icon: github.icon.Github
  //   })
  //   await client.createMixin(
  //     projectInst._id,
  //     tracker.class.Issue,
  //     core.space.Space,
  //     github.mixin.GithubProject,
  //     {
  //       integration: integration._id,
  //       repositories: [],
  //       mixinClass: mixinId,
  //       mappings: []
  //     }
  //   )
  // }

  // await this.client.createMixin(targetClassId, tracker.class.Issue, prj._id, github.mixin.GithubIssue, {
  //   githubNumber: issueExternal.number,
  //   url: issueExternal.url,
  //   repository: repo,
  //   descriptionLocked: isDescriptionLocked
  // })
  // await this.client.createMixin<Issue, Issue>(issueId, github.mixin.GithubIssue, prj._id, prj.mixinClass, {})

  await createProjectType(client, {
    name: 'ClickUp project',
    descriptor: tracker.descriptors.ProjectType,
    shortDescription: 'For issues imported from ClickUp',
    description: '',
    tasks: [],
    roles: 0,
    classic: true
  }, [{
    _id: CLICKUP_TASK_TYPE_ID,
    descriptor: tracker.descriptors.Issue,
    kind: 'both',
    name: 'ClickUp issue',
    ofClass: tracker.class.Issue,
    // targetClass: targetClassId,
    statusCategories: [task.statusCategory.UnStarted],
    statusClass: tracker.class.IssueStatus,
    icon: tracker.icon.Issue,
    color: 0,
    allowedAsChildOf: [CLICKUP_TASK_TYPE_ID],
    factory: statuses.map(status => {
      return {
        name: status,
        ofAttribute: pluginState.attribute.IssueStatus,
        category: task.statusCategory.UnStarted
      }
    })
  }],
  CLICKUP_PROJECT_TYPE_ID
  )
}
