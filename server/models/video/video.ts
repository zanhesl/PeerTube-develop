import * as Bluebird from 'bluebird'
import { remove } from 'fs-extra'
import { maxBy, minBy, pick } from 'lodash'
import { join } from 'path'
import { FindOptions, Includeable, IncludeOptions, Op, QueryTypes, ScopeOptions, Sequelize, Transaction, WhereOptions } from 'sequelize'
import {
  AllowNull,
  BeforeDestroy,
  BelongsTo,
  BelongsToMany,
  Column,
  CreatedAt,
  DataType,
  Default,
  ForeignKey,
  HasMany,
  HasOne,
  Is,
  IsInt,
  IsUUID,
  Min,
  Model,
  Scopes,
  Table,
  UpdatedAt
} from 'sequelize-typescript'
import { buildNSFWFilter } from '@server/helpers/express-utils'
import { getPrivaciesForFederation, isPrivacyForFederation, isStateForFederation } from '@server/helpers/video'
import { LiveManager } from '@server/lib/live-manager'
import { getHLSDirectory, getVideoFilePath } from '@server/lib/video-paths'
import { getServerActor } from '@server/models/application/application'
import { ModelCache } from '@server/models/model-cache'
import { VideoFile } from '@shared/models/videos/video-file.model'
import { ResultList, UserRight, VideoPrivacy, VideoState } from '../../../shared'
import { VideoObject } from '../../../shared/models/activitypub/objects'
import { Video, VideoDetails, VideoRateType } from '../../../shared/models/videos'
import { ThumbnailType } from '../../../shared/models/videos/thumbnail.type'
import { VideoFilter } from '../../../shared/models/videos/video-query.type'
import { VideoStreamingPlaylistType } from '../../../shared/models/videos/video-streaming-playlist.type'
import { peertubeTruncate } from '../../helpers/core-utils'
import { isActivityPubUrlValid } from '../../helpers/custom-validators/activitypub/misc'
import { isBooleanValid } from '../../helpers/custom-validators/misc'
import {
  isVideoCategoryValid,
  isVideoDescriptionValid,
  isVideoDurationValid,
  isVideoLanguageValid,
  isVideoLicenceValid,
  isVideoNameValid,
  isVideoPrivacyValid,
  isVideoStateValid,
  isVideoSupportValid
} from '../../helpers/custom-validators/videos'
import { getVideoFileResolution } from '../../helpers/ffprobe-utils'
import { logger } from '../../helpers/logger'
import { CONFIG } from '../../initializers/config'
import {
  ACTIVITY_PUB,
  API_VERSION,
  CONSTRAINTS_FIELDS,
  LAZY_STATIC_PATHS,
  STATIC_PATHS,
  VIDEO_CATEGORIES,
  VIDEO_LANGUAGES,
  VIDEO_LICENCES,
  VIDEO_PRIVACIES,
  VIDEO_STATES,
  WEBSERVER
} from '../../initializers/constants'
import { sendDeleteVideo } from '../../lib/activitypub/send'
import {
  MChannel,
  MChannelAccountDefault,
  MChannelId,
  MStreamingPlaylist,
  MStreamingPlaylistFilesVideo,
  MUserAccountId,
  MUserId,
  MVideo,
  MVideoAccountLight,
  MVideoAccountLightBlacklistAllFiles,
  MVideoAP,
  MVideoDetails,
  MVideoFileVideo,
  MVideoFormattable,
  MVideoFormattableDetails,
  MVideoForUser,
  MVideoFullLight,
  MVideoIdThumbnail,
  MVideoImmutable,
  MVideoThumbnail,
  MVideoThumbnailBlacklist,
  MVideoWithAllFiles,
  MVideoWithFile,
  MVideoWithRights
} from '../../types/models'
import { MThumbnail } from '../../types/models/video/thumbnail'
import { MVideoFile, MVideoFileStreamingPlaylistVideo } from '../../types/models/video/video-file'
import { VideoAbuseModel } from '../abuse/video-abuse'
import { AccountModel } from '../account/account'
import { AccountVideoRateModel } from '../account/account-video-rate'
import { ActorImageModel } from '../account/actor-image'
import { UserModel } from '../account/user'
import { UserVideoHistoryModel } from '../account/user-video-history'
import { ActorModel } from '../activitypub/actor'
import { VideoRedundancyModel } from '../redundancy/video-redundancy'
import { ServerModel } from '../server/server'
import { TrackerModel } from '../server/tracker'
import { VideoTrackerModel } from '../server/video-tracker'
import { buildTrigramSearchIndex, buildWhereIdOrUUID, getVideoSort, isOutdated, throwIfNotValid } from '../utils'
import { ScheduleVideoUpdateModel } from './schedule-video-update'
import { TagModel } from './tag'
import { ThumbnailModel } from './thumbnail'
import { VideoBlacklistModel } from './video-blacklist'
import { VideoCaptionModel } from './video-caption'
import { ScopeNames as VideoChannelScopeNames, SummaryOptions, VideoChannelModel } from './video-channel'
import { VideoCommentModel } from './video-comment'
import { VideoFileModel } from './video-file'
import {
  videoFilesModelToFormattedJSON,
  VideoFormattingJSONOptions,
  videoModelToActivityPubObject,
  videoModelToFormattedDetailsJSON,
  videoModelToFormattedJSON
} from './video-format-utils'
import { VideoImportModel } from './video-import'
import { VideoLiveModel } from './video-live'
import { VideoPlaylistElementModel } from './video-playlist-element'
import { buildListQuery, BuildVideosQueryOptions, wrapForAPIResults } from './video-query-builder'
import { VideoShareModel } from './video-share'
import { VideoStreamingPlaylistModel } from './video-streaming-playlist'
import { VideoTagModel } from './video-tag'
import { VideoViewModel } from './video-view'

export enum ScopeNames {
  AVAILABLE_FOR_LIST_IDS = 'AVAILABLE_FOR_LIST_IDS',
  FOR_API = 'FOR_API',
  WITH_ACCOUNT_DETAILS = 'WITH_ACCOUNT_DETAILS',
  WITH_TAGS = 'WITH_TAGS',
  WITH_TRACKERS = 'WITH_TRACKERS',
  WITH_WEBTORRENT_FILES = 'WITH_WEBTORRENT_FILES',
  WITH_SCHEDULED_UPDATE = 'WITH_SCHEDULED_UPDATE',
  WITH_BLACKLISTED = 'WITH_BLACKLISTED',
  WITH_USER_HISTORY = 'WITH_USER_HISTORY',
  WITH_STREAMING_PLAYLISTS = 'WITH_STREAMING_PLAYLISTS',
  WITH_USER_ID = 'WITH_USER_ID',
  WITH_IMMUTABLE_ATTRIBUTES = 'WITH_IMMUTABLE_ATTRIBUTES',
  WITH_THUMBNAILS = 'WITH_THUMBNAILS',
  WITH_LIVE = 'WITH_LIVE'
}

export type ForAPIOptions = {
  ids?: number[]

  videoPlaylistId?: number

  withAccountBlockerIds?: number[]
}

export type AvailableForListIDsOptions = {
  serverAccountId: number
  followerActorId: number
  includeLocalVideos: boolean

  attributesType?: 'none' | 'id' | 'all'

  filter?: VideoFilter
  categoryOneOf?: number[]
  nsfw?: boolean
  licenceOneOf?: number[]
  languageOneOf?: string[]
  tagsOneOf?: string[]
  tagsAllOf?: string[]

  withFiles?: boolean

  accountId?: number
  videoChannelId?: number

  videoPlaylistId?: number

  trendingDays?: number
  user?: MUserAccountId
  historyOfUser?: MUserId

  baseWhere?: WhereOptions[]
}

@Scopes(() => ({
  [ScopeNames.WITH_IMMUTABLE_ATTRIBUTES]: {
    attributes: [ 'id', 'url', 'uuid', 'remote' ]
  },
  [ScopeNames.FOR_API]: (options: ForAPIOptions) => {
    const include: Includeable[] = [
      {
        model: VideoChannelModel.scope({
          method: [
            VideoChannelScopeNames.SUMMARY, {
              withAccount: true,
              withAccountBlockerIds: options.withAccountBlockerIds
            } as SummaryOptions
          ]
        }),
        required: true
      },
      {
        attributes: [ 'type', 'filename' ],
        model: ThumbnailModel,
        required: false
      }
    ]

    const query: FindOptions = {}

    if (options.ids) {
      query.where = {
        id: {
          [Op.in]: options.ids
        }
      }
    }

    if (options.videoPlaylistId) {
      include.push({
        model: VideoPlaylistElementModel.unscoped(),
        required: true,
        where: {
          videoPlaylistId: options.videoPlaylistId
        }
      })
    }

    query.include = include

    return query
  },
  [ScopeNames.WITH_THUMBNAILS]: {
    include: [
      {
        model: ThumbnailModel,
        required: false
      }
    ]
  },
  [ScopeNames.WITH_LIVE]: {
    include: [
      {
        model: VideoLiveModel.unscoped(),
        required: false
      }
    ]
  },
  [ScopeNames.WITH_USER_ID]: {
    include: [
      {
        attributes: [ 'accountId' ],
        model: VideoChannelModel.unscoped(),
        required: true,
        include: [
          {
            attributes: [ 'userId' ],
            model: AccountModel.unscoped(),
            required: true
          }
        ]
      }
    ]
  },
  [ScopeNames.WITH_ACCOUNT_DETAILS]: {
    include: [
      {
        model: VideoChannelModel.unscoped(),
        required: true,
        include: [
          {
            attributes: {
              exclude: [ 'privateKey', 'publicKey' ]
            },
            model: ActorModel.unscoped(),
            required: true,
            include: [
              {
                attributes: [ 'host' ],
                model: ServerModel.unscoped(),
                required: false
              },
              {
                model: ActorImageModel.unscoped(),
                as: 'Avatar',
                required: false
              }
            ]
          },
          {
            model: AccountModel.unscoped(),
            required: true,
            include: [
              {
                model: ActorModel.unscoped(),
                attributes: {
                  exclude: [ 'privateKey', 'publicKey' ]
                },
                required: true,
                include: [
                  {
                    attributes: [ 'host' ],
                    model: ServerModel.unscoped(),
                    required: false
                  },
                  {
                    model: ActorImageModel.unscoped(),
                    as: 'Avatar',
                    required: false
                  }
                ]
              }
            ]
          }
        ]
      }
    ]
  },
  [ScopeNames.WITH_TAGS]: {
    include: [ TagModel ]
  },
  [ScopeNames.WITH_TRACKERS]: {
    include: [
      {
        attributes: [ 'id', 'url' ],
        model: TrackerModel
      }
    ]
  },
  [ScopeNames.WITH_BLACKLISTED]: {
    include: [
      {
        attributes: [ 'id', 'reason', 'unfederated' ],
        model: VideoBlacklistModel,
        required: false
      }
    ]
  },
  [ScopeNames.WITH_WEBTORRENT_FILES]: (withRedundancies = false) => {
    let subInclude: any[] = []

    if (withRedundancies === true) {
      subInclude = [
        {
          attributes: [ 'fileUrl' ],
          model: VideoRedundancyModel.unscoped(),
          required: false
        }
      ]
    }

    return {
      include: [
        {
          model: VideoFileModel,
          separate: true,
          required: false,
          include: subInclude
        }
      ]
    }
  },
  [ScopeNames.WITH_STREAMING_PLAYLISTS]: (withRedundancies = false) => {
    const subInclude: IncludeOptions[] = [
      {
        model: VideoFileModel,
        required: false
      }
    ]

    if (withRedundancies === true) {
      subInclude.push({
        attributes: [ 'fileUrl' ],
        model: VideoRedundancyModel.unscoped(),
        required: false
      })
    }

    return {
      include: [
        {
          model: VideoStreamingPlaylistModel.unscoped(),
          required: false,
          separate: true,
          include: subInclude
        }
      ]
    }
  },
  [ScopeNames.WITH_SCHEDULED_UPDATE]: {
    include: [
      {
        model: ScheduleVideoUpdateModel.unscoped(),
        required: false
      }
    ]
  },
  [ScopeNames.WITH_USER_HISTORY]: (userId: number) => {
    return {
      include: [
        {
          attributes: [ 'currentTime' ],
          model: UserVideoHistoryModel.unscoped(),
          required: false,
          where: {
            userId
          }
        }
      ]
    }
  }
}))
@Table({
  tableName: 'video',
  indexes: [
    buildTrigramSearchIndex('video_name_trigram', 'name'),

    { fields: [ 'createdAt' ] },
    {
      fields: [
        { name: 'publishedAt', order: 'DESC' },
        { name: 'id', order: 'ASC' }
      ]
    },
    { fields: [ 'duration' ] },
    {
      fields: [
        { name: 'views', order: 'DESC' },
        { name: 'id', order: 'ASC' }
      ]
    },
    { fields: [ 'channelId' ] },
    {
      fields: [ 'originallyPublishedAt' ],
      where: {
        originallyPublishedAt: {
          [Op.ne]: null
        }
      }
    },
    {
      fields: [ 'category' ], // We don't care videos with an unknown category
      where: {
        category: {
          [Op.ne]: null
        }
      }
    },
    {
      fields: [ 'licence' ], // We don't care videos with an unknown licence
      where: {
        licence: {
          [Op.ne]: null
        }
      }
    },
    {
      fields: [ 'language' ], // We don't care videos with an unknown language
      where: {
        language: {
          [Op.ne]: null
        }
      }
    },
    {
      fields: [ 'nsfw' ], // Most of the videos are not NSFW
      where: {
        nsfw: true
      }
    },
    {
      fields: [ 'remote' ], // Only index local videos
      where: {
        remote: false
      }
    },
    {
      fields: [ 'uuid' ],
      unique: true
    },
    {
      fields: [ 'url' ],
      unique: true
    }
  ]
})
export class VideoModel extends Model {

  @AllowNull(false)
  @Default(DataType.UUIDV4)
  @IsUUID(4)
  @Column(DataType.UUID)
  uuid: string

  @AllowNull(false)
  @Is('VideoName', value => throwIfNotValid(value, isVideoNameValid, 'name'))
  @Column
  name: string

  @AllowNull(true)
  @Default(null)
  @Is('VideoCategory', value => throwIfNotValid(value, isVideoCategoryValid, 'category', true))
  @Column
  category: number

  @AllowNull(true)
  @Default(null)
  @Is('VideoLicence', value => throwIfNotValid(value, isVideoLicenceValid, 'licence', true))
  @Column
  licence: number

  @AllowNull(true)
  @Default(null)
  @Is('VideoLanguage', value => throwIfNotValid(value, isVideoLanguageValid, 'language', true))
  @Column(DataType.STRING(CONSTRAINTS_FIELDS.VIDEOS.LANGUAGE.max))
  language: string

  @AllowNull(false)
  @Is('VideoPrivacy', value => throwIfNotValid(value, isVideoPrivacyValid, 'privacy'))
  @Column
  privacy: VideoPrivacy

  @AllowNull(false)
  @Is('VideoNSFW', value => throwIfNotValid(value, isBooleanValid, 'NSFW boolean'))
  @Column
  nsfw: boolean

  @AllowNull(true)
  @Default(null)
  @Is('VideoDescription', value => throwIfNotValid(value, isVideoDescriptionValid, 'description', true))
  @Column(DataType.STRING(CONSTRAINTS_FIELDS.VIDEOS.DESCRIPTION.max))
  description: string

  @AllowNull(true)
  @Default(null)
  @Is('VideoSupport', value => throwIfNotValid(value, isVideoSupportValid, 'support', true))
  @Column(DataType.STRING(CONSTRAINTS_FIELDS.VIDEOS.SUPPORT.max))
  support: string

  @AllowNull(false)
  @Is('VideoDuration', value => throwIfNotValid(value, isVideoDurationValid, 'duration'))
  @Column
  duration: number

  @AllowNull(false)
  @Default(0)
  @IsInt
  @Min(0)
  @Column
  views: number

  @AllowNull(false)
  @Default(0)
  @IsInt
  @Min(0)
  @Column
  likes: number

  @AllowNull(false)
  @Default(0)
  @IsInt
  @Min(0)
  @Column
  dislikes: number

  @AllowNull(false)
  @Column
  remote: boolean

  @AllowNull(false)
  @Default(false)
  @Column
  isLive: boolean

  @AllowNull(false)
  @Is('VideoUrl', value => throwIfNotValid(value, isActivityPubUrlValid, 'url'))
  @Column(DataType.STRING(CONSTRAINTS_FIELDS.VIDEOS.URL.max))
  url: string

  @AllowNull(false)
  @Column
  commentsEnabled: boolean

  @AllowNull(false)
  @Column
  downloadEnabled: boolean

  @AllowNull(false)
  @Column
  waitTranscoding: boolean

  @AllowNull(false)
  @Default(null)
  @Is('VideoState', value => throwIfNotValid(value, isVideoStateValid, 'state'))
  @Column
  state: VideoState

  @CreatedAt
  createdAt: Date

  @UpdatedAt
  updatedAt: Date

  @AllowNull(false)
  @Default(DataType.NOW)
  @Column
  publishedAt: Date

  @AllowNull(true)
  @Default(null)
  @Column
  originallyPublishedAt: Date

  @AllowNull(false)
  @Default(0)
  @Column
  aspectRatio: number

  @ForeignKey(() => VideoChannelModel)
  @Column
  channelId: number

  @BelongsTo(() => VideoChannelModel, {
    foreignKey: {
      allowNull: true
    },
    hooks: true
  })
  VideoChannel: VideoChannelModel

  @BelongsToMany(() => TagModel, {
    foreignKey: 'videoId',
    through: () => VideoTagModel,
    onDelete: 'CASCADE'
  })
  Tags: TagModel[]

  @BelongsToMany(() => TrackerModel, {
    foreignKey: 'videoId',
    through: () => VideoTrackerModel,
    onDelete: 'CASCADE'
  })
  Trackers: TrackerModel[]

  @HasMany(() => ThumbnailModel, {
    foreignKey: {
      name: 'videoId',
      allowNull: true
    },
    hooks: true,
    onDelete: 'cascade'
  })
  Thumbnails: ThumbnailModel[]

  @HasMany(() => VideoPlaylistElementModel, {
    foreignKey: {
      name: 'videoId',
      allowNull: true
    },
    onDelete: 'set null'
  })
  VideoPlaylistElements: VideoPlaylistElementModel[]

  @HasMany(() => VideoAbuseModel, {
    foreignKey: {
      name: 'videoId',
      allowNull: true
    },
    onDelete: 'set null'
  })
  VideoAbuses: VideoAbuseModel[]

  @HasMany(() => VideoFileModel, {
    foreignKey: {
      name: 'videoId',
      allowNull: true
    },
    hooks: true,
    onDelete: 'cascade'
  })
  VideoFiles: VideoFileModel[]

  @HasMany(() => VideoStreamingPlaylistModel, {
    foreignKey: {
      name: 'videoId',
      allowNull: false
    },
    hooks: true,
    onDelete: 'cascade'
  })
  VideoStreamingPlaylists: VideoStreamingPlaylistModel[]

  @HasMany(() => VideoShareModel, {
    foreignKey: {
      name: 'videoId',
      allowNull: false
    },
    onDelete: 'cascade'
  })
  VideoShares: VideoShareModel[]

  @HasMany(() => AccountVideoRateModel, {
    foreignKey: {
      name: 'videoId',
      allowNull: false
    },
    onDelete: 'cascade'
  })
  AccountVideoRates: AccountVideoRateModel[]

  @HasMany(() => VideoCommentModel, {
    foreignKey: {
      name: 'videoId',
      allowNull: false
    },
    onDelete: 'cascade',
    hooks: true
  })
  VideoComments: VideoCommentModel[]

  @HasMany(() => VideoViewModel, {
    foreignKey: {
      name: 'videoId',
      allowNull: false
    },
    onDelete: 'cascade'
  })
  VideoViews: VideoViewModel[]

  @HasMany(() => UserVideoHistoryModel, {
    foreignKey: {
      name: 'videoId',
      allowNull: false
    },
    onDelete: 'cascade'
  })
  UserVideoHistories: UserVideoHistoryModel[]

  @HasOne(() => ScheduleVideoUpdateModel, {
    foreignKey: {
      name: 'videoId',
      allowNull: false
    },
    onDelete: 'cascade'
  })
  ScheduleVideoUpdate: ScheduleVideoUpdateModel

  @HasOne(() => VideoBlacklistModel, {
    foreignKey: {
      name: 'videoId',
      allowNull: false
    },
    onDelete: 'cascade'
  })
  VideoBlacklist: VideoBlacklistModel

  @HasOne(() => VideoLiveModel, {
    foreignKey: {
      name: 'videoId',
      allowNull: false
    },
    onDelete: 'cascade'
  })
  VideoLive: VideoLiveModel

  @HasOne(() => VideoImportModel, {
    foreignKey: {
      name: 'videoId',
      allowNull: true
    },
    onDelete: 'set null'
  })
  VideoImport: VideoImportModel

  @HasMany(() => VideoCaptionModel, {
    foreignKey: {
      name: 'videoId',
      allowNull: false
    },
    onDelete: 'cascade',
    hooks: true,
    ['separate' as any]: true
  })
  VideoCaptions: VideoCaptionModel[]

  @BeforeDestroy
  static async sendDelete (instance: MVideoAccountLight, options) {
    if (!instance.isOwned()) return undefined

    // Lazy load channels
    if (!instance.VideoChannel) {
      instance.VideoChannel = await instance.$get('VideoChannel', {
        include: [
          ActorModel,
          AccountModel
        ],
        transaction: options.transaction
      }) as MChannelAccountDefault
    }

    return sendDeleteVideo(instance, options.transaction)
  }

  @BeforeDestroy
  static async removeFiles (instance: VideoModel) {
    const tasks: Promise<any>[] = []

    logger.info('Removing files of video %s.', instance.url)

    if (instance.isOwned()) {
      if (!Array.isArray(instance.VideoFiles)) {
        instance.VideoFiles = await instance.$get('VideoFiles')
      }

      // Remove physical files and torrents
      instance.VideoFiles.forEach(file => {
        tasks.push(instance.removeFile(file))
        tasks.push(file.removeTorrent())
      })

      // Remove playlists file
      if (!Array.isArray(instance.VideoStreamingPlaylists)) {
        instance.VideoStreamingPlaylists = await instance.$get('VideoStreamingPlaylists')
      }

      for (const p of instance.VideoStreamingPlaylists) {
        tasks.push(instance.removeStreamingPlaylistFiles(p))
      }
    }

    // Do not wait video deletion because we could be in a transaction
    Promise.all(tasks)
           .catch(err => {
             logger.error('Some errors when removing files of video %s in before destroy hook.', instance.uuid, { err })
           })

    return undefined
  }

  @BeforeDestroy
  static stopLiveIfNeeded (instance: VideoModel) {
    if (!instance.isLive) return

    logger.info('Stopping live of video %s after video deletion.', instance.uuid)

    return LiveManager.Instance.stopSessionOf(instance.id)
  }

  @BeforeDestroy
  static invalidateCache (instance: VideoModel) {
    ModelCache.Instance.invalidateCache('video', instance.id)
  }

  @BeforeDestroy
  static async saveEssentialDataToAbuses (instance: VideoModel, options) {
    const tasks: Promise<any>[] = []

    if (!Array.isArray(instance.VideoAbuses)) {
      instance.VideoAbuses = await instance.$get('VideoAbuses')

      if (instance.VideoAbuses.length === 0) return undefined
    }

    logger.info('Saving video abuses details of video %s.', instance.url)

    if (!instance.Trackers) instance.Trackers = await instance.$get('Trackers', { transaction: options.transaction })
    const details = instance.toFormattedDetailsJSON()

    for (const abuse of instance.VideoAbuses) {
      abuse.deletedVideo = details
      tasks.push(abuse.save({ transaction: options.transaction }))
    }

    Promise.all(tasks)
           .catch(err => {
             logger.error('Some errors when saving details of video %s in its abuses before destroy hook.', instance.uuid, { err })
           })

    return undefined
  }

  static listLocal (): Promise<MVideo[]> {
    const query = {
      where: {
        remote: false
      }
    }

    return VideoModel.findAll(query)
  }

  static listAllAndSharedByActorForOutbox (actorId: number, start: number, count: number) {
    function getRawQuery (select: string) {
      const queryVideo = 'SELECT ' + select + ' FROM "video" AS "Video" ' +
        'INNER JOIN "videoChannel" AS "VideoChannel" ON "VideoChannel"."id" = "Video"."channelId" ' +
        'INNER JOIN "account" AS "Account" ON "Account"."id" = "VideoChannel"."accountId" ' +
        'WHERE "Account"."actorId" = ' + actorId
      const queryVideoShare = 'SELECT ' + select + ' FROM "videoShare" AS "VideoShare" ' +
        'INNER JOIN "video" AS "Video" ON "Video"."id" = "VideoShare"."videoId" ' +
        'WHERE "VideoShare"."actorId" = ' + actorId

      return `(${queryVideo}) UNION (${queryVideoShare})`
    }

    const rawQuery = getRawQuery('"Video"."id"')
    const rawCountQuery = getRawQuery('COUNT("Video"."id") as "total"')

    const query = {
      distinct: true,
      offset: start,
      limit: count,
      order: getVideoSort('-createdAt', [ 'Tags', 'name', 'ASC' ] as any), // FIXME: sequelize typings
      where: {
        id: {
          [Op.in]: Sequelize.literal('(' + rawQuery + ')')
        },
        [Op.or]: getPrivaciesForFederation()
      },
      include: [
        {
          attributes: [ 'filename', 'language', 'fileUrl' ],
          model: VideoCaptionModel.unscoped(),
          required: false
        },
        {
          attributes: [ 'id', 'url' ],
          model: VideoShareModel.unscoped(),
          required: false,
          // We only want videos shared by this actor
          where: {
            [Op.and]: [
              {
                id: {
                  [Op.not]: null
                }
              },
              {
                actorId
              }
            ]
          },
          include: [
            {
              attributes: [ 'id', 'url' ],
              model: ActorModel.unscoped()
            }
          ]
        },
        {
          model: VideoChannelModel.unscoped(),
          required: true,
          include: [
            {
              attributes: [ 'name' ],
              model: AccountModel.unscoped(),
              required: true,
              include: [
                {
                  attributes: [ 'id', 'url', 'followersUrl' ],
                  model: ActorModel.unscoped(),
                  required: true
                }
              ]
            },
            {
              attributes: [ 'id', 'url', 'followersUrl' ],
              model: ActorModel.unscoped(),
              required: true
            }
          ]
        },
        {
          model: VideoStreamingPlaylistModel.unscoped(),
          required: false,
          include: [
            {
              model: VideoFileModel,
              required: false
            }
          ]
        },
        VideoLiveModel.unscoped(),
        VideoFileModel,
        TagModel
      ]
    }

    return Bluebird.all([
      VideoModel.scope(ScopeNames.WITH_THUMBNAILS).findAll(query),
      VideoModel.sequelize.query<{ total: string }>(rawCountQuery, { type: QueryTypes.SELECT })
    ]).then(([ rows, totals ]) => {
      // totals: totalVideos + totalVideoShares
      let totalVideos = 0
      let totalVideoShares = 0
      if (totals[0]) totalVideos = parseInt(totals[0].total, 10)
      if (totals[1]) totalVideoShares = parseInt(totals[1].total, 10)

      const total = totalVideos + totalVideoShares
      return {
        data: rows,
        total: total
      }
    })
  }

  static async listPublishedLiveIds () {
    const options = {
      attributes: [ 'id' ],
      where: {
        isLive: true,
        state: VideoState.PUBLISHED
      }
    }

    const result = await VideoModel.findAll(options)

    return result.map(v => v.id)
  }

  static listUserVideosForApi (options: {
    accountId: number
    start: number
    count: number
    sort: string
    search?: string
  }) {
    const { accountId, start, count, sort, search } = options

    function buildBaseQuery (): FindOptions {
      let baseQuery = {
        offset: start,
        limit: count,
        order: getVideoSort(sort),
        include: [
          {
            model: VideoChannelModel,
            required: true,
            include: [
              {
                model: AccountModel,
                where: {
                  id: accountId
                },
                required: true
              }
            ]
          }
        ]
      }

      if (search) {
        baseQuery = Object.assign(baseQuery, {
          where: {
            name: {
              [Op.iLike]: '%' + search + '%'
            }
          }
        })
      }

      return baseQuery
    }

    const countQuery = buildBaseQuery()
    const findQuery = buildBaseQuery()

    const findScopes: (string | ScopeOptions)[] = [
      ScopeNames.WITH_SCHEDULED_UPDATE,
      ScopeNames.WITH_BLACKLISTED,
      ScopeNames.WITH_THUMBNAILS
    ]

    return Promise.all([
      VideoModel.count(countQuery),
      VideoModel.scope(findScopes).findAll<MVideoForUser>(findQuery)
    ]).then(([ count, rows ]) => {
      return {
        data: rows,
        total: count
      }
    })
  }

  static async listForApi (options: {
    start: number
    count: number
    sort: string
    nsfw: boolean
    includeLocalVideos: boolean
    withFiles: boolean
    categoryOneOf?: number[]
    licenceOneOf?: number[]
    languageOneOf?: string[]
    tagsOneOf?: string[]
    tagsAllOf?: string[]
    filter?: VideoFilter
    accountId?: number
    videoChannelId?: number
    followerActorId?: number
    videoPlaylistId?: number
    trendingDays?: number
    user?: MUserAccountId
    historyOfUser?: MUserId
    countVideos?: boolean
    search?: string
  }) {
    if ((options.filter === 'all-local' || options.filter === 'all') && !options.user.hasRight(UserRight.SEE_ALL_VIDEOS)) {
      throw new Error('Try to filter all-local but no user has not the see all videos right')
    }

    const trendingDays = options.sort.endsWith('trending')
      ? CONFIG.TRENDING.VIDEOS.INTERVAL_DAYS
      : undefined
    let trendingAlgorithm
    if (options.sort.endsWith('hot')) trendingAlgorithm = 'hot'
    if (options.sort.endsWith('best')) trendingAlgorithm = 'best'

    const serverActor = await getServerActor()

    // followerActorId === null has a meaning, so just check undefined
    const followerActorId = options.followerActorId !== undefined
      ? options.followerActorId
      : serverActor.id

    const queryOptions = {
      start: options.start,
      count: options.count,
      sort: options.sort,
      followerActorId,
      serverAccountId: serverActor.Account.id,
      nsfw: options.nsfw,
      categoryOneOf: options.categoryOneOf,
      licenceOneOf: options.licenceOneOf,
      languageOneOf: options.languageOneOf,
      tagsOneOf: options.tagsOneOf,
      tagsAllOf: options.tagsAllOf,
      filter: options.filter,
      withFiles: options.withFiles,
      accountId: options.accountId,
      videoChannelId: options.videoChannelId,
      videoPlaylistId: options.videoPlaylistId,
      includeLocalVideos: options.includeLocalVideos,
      user: options.user,
      historyOfUser: options.historyOfUser,
      trendingDays,
      trendingAlgorithm,
      search: options.search
    }

    return VideoModel.getAvailableForApi(queryOptions, options.countVideos)
  }

  static async searchAndPopulateAccountAndServer (options: {
    includeLocalVideos: boolean
    search?: string
    start?: number
    count?: number
    sort?: string
    startDate?: string // ISO 8601
    endDate?: string // ISO 8601
    originallyPublishedStartDate?: string
    originallyPublishedEndDate?: string
    nsfw?: boolean
    categoryOneOf?: number[]
    licenceOneOf?: number[]
    languageOneOf?: string[]
    tagsOneOf?: string[]
    tagsAllOf?: string[]
    durationMin?: number // seconds
    durationMax?: number // seconds
    user?: MUserAccountId
    filter?: VideoFilter
  }) {
    const serverActor = await getServerActor()
    const queryOptions = {
      followerActorId: serverActor.id,
      serverAccountId: serverActor.Account.id,
      includeLocalVideos: options.includeLocalVideos,
      nsfw: options.nsfw,
      categoryOneOf: options.categoryOneOf,
      licenceOneOf: options.licenceOneOf,
      languageOneOf: options.languageOneOf,
      tagsOneOf: options.tagsOneOf,
      tagsAllOf: options.tagsAllOf,
      user: options.user,
      filter: options.filter,
      start: options.start,
      count: options.count,
      sort: options.sort,
      startDate: options.startDate,
      endDate: options.endDate,
      originallyPublishedStartDate: options.originallyPublishedStartDate,
      originallyPublishedEndDate: options.originallyPublishedEndDate,

      durationMin: options.durationMin,
      durationMax: options.durationMax,

      search: options.search
    }

    return VideoModel.getAvailableForApi(queryOptions)
  }

  static countLocalLives () {
    const options = {
      where: {
        remote: false,
        isLive: true,
        state: {
          [Op.ne]: VideoState.LIVE_ENDED
        }
      }
    }

    return VideoModel.count(options)
  }

  static countVideosUploadedByUserSince (userId: number, since: Date) {
    const options = {
      include: [
        {
          model: VideoChannelModel.unscoped(),
          required: true,
          include: [
            {
              model: AccountModel.unscoped(),
              required: true,
              include: [
                {
                  model: UserModel.unscoped(),
                  required: true,
                  where: {
                    id: userId
                  }
                }
              ]
            }
          ]
        }
      ],
      where: {
        createdAt: {
          [Op.gte]: since
        }
      }
    }

    return VideoModel.unscoped().count(options)
  }

  static countLivesOfAccount (accountId: number) {
    const options = {
      where: {
        remote: false,
        isLive: true,
        state: {
          [Op.ne]: VideoState.LIVE_ENDED
        }
      },
      include: [
        {
          required: true,
          model: VideoChannelModel.unscoped(),
          where: {
            accountId
          }
        }
      ]
    }

    return VideoModel.count(options)
  }

  static load (id: number | string, t?: Transaction): Promise<MVideoThumbnail> {
    const where = buildWhereIdOrUUID(id)
    const options = {
      where,
      transaction: t
    }

    return VideoModel.scope(ScopeNames.WITH_THUMBNAILS).findOne(options)
  }

  static loadWithBlacklist (id: number | string, t?: Transaction): Promise<MVideoThumbnailBlacklist> {
    const where = buildWhereIdOrUUID(id)
    const options = {
      where,
      transaction: t
    }

    return VideoModel.scope([
      ScopeNames.WITH_THUMBNAILS,
      ScopeNames.WITH_BLACKLISTED
    ]).findOne(options)
  }

  static loadImmutableAttributes (id: number | string, t?: Transaction): Promise<MVideoImmutable> {
    const fun = () => {
      const query = {
        where: buildWhereIdOrUUID(id),
        transaction: t
      }

      return VideoModel.scope(ScopeNames.WITH_IMMUTABLE_ATTRIBUTES).findOne(query)
    }

    return ModelCache.Instance.doCache({
      cacheType: 'load-video-immutable-id',
      key: '' + id,
      deleteKey: 'video',
      fun
    })
  }

  static loadWithRights (id: number | string, t?: Transaction): Promise<MVideoWithRights> {
    const where = buildWhereIdOrUUID(id)
    const options = {
      where,
      transaction: t
    }

    return VideoModel.scope([
      ScopeNames.WITH_BLACKLISTED,
      ScopeNames.WITH_USER_ID
    ]).findOne(options)
  }

  static loadOnlyId (id: number | string, t?: Transaction): Promise<MVideoIdThumbnail> {
    const where = buildWhereIdOrUUID(id)

    const options = {
      attributes: [ 'id' ],
      where,
      transaction: t
    }

    return VideoModel.scope(ScopeNames.WITH_THUMBNAILS).findOne(options)
  }

  static loadWithFiles (id: number | string, t?: Transaction, logging?: boolean): Promise<MVideoWithAllFiles> {
    const where = buildWhereIdOrUUID(id)

    const query = {
      where,
      transaction: t,
      logging
    }

    return VideoModel.scope([
      ScopeNames.WITH_WEBTORRENT_FILES,
      ScopeNames.WITH_STREAMING_PLAYLISTS,
      ScopeNames.WITH_THUMBNAILS
    ]).findOne(query)
  }

  static loadByUUID (uuid: string): Promise<MVideoThumbnail> {
    const options = {
      where: {
        uuid
      }
    }

    return VideoModel.scope(ScopeNames.WITH_THUMBNAILS).findOne(options)
  }

  static loadByUrl (url: string, transaction?: Transaction): Promise<MVideoThumbnail> {
    const query: FindOptions = {
      where: {
        url
      },
      transaction
    }

    return VideoModel.scope(ScopeNames.WITH_THUMBNAILS).findOne(query)
  }

  static loadByUrlImmutableAttributes (url: string, transaction?: Transaction): Promise<MVideoImmutable> {
    const fun = () => {
      const query: FindOptions = {
        where: {
          url
        },
        transaction
      }

      return VideoModel.scope(ScopeNames.WITH_IMMUTABLE_ATTRIBUTES).findOne(query)
    }

    return ModelCache.Instance.doCache({
      cacheType: 'load-video-immutable-url',
      key: url,
      deleteKey: 'video',
      fun
    })
  }

  static loadByUrlAndPopulateAccount (url: string, transaction?: Transaction): Promise<MVideoAccountLightBlacklistAllFiles> {
    const query: FindOptions = {
      where: {
        url
      },
      transaction
    }

    return VideoModel.scope([
      ScopeNames.WITH_ACCOUNT_DETAILS,
      ScopeNames.WITH_WEBTORRENT_FILES,
      ScopeNames.WITH_STREAMING_PLAYLISTS,
      ScopeNames.WITH_THUMBNAILS,
      ScopeNames.WITH_BLACKLISTED
    ]).findOne(query)
  }

  static loadAndPopulateAccountAndServerAndTags (id: number | string, t?: Transaction, userId?: number): Promise<MVideoFullLight> {
    const where = buildWhereIdOrUUID(id)

    const options = {
      order: [ [ 'Tags', 'name', 'ASC' ] ] as any,
      where,
      transaction: t
    }

    const scopes: (string | ScopeOptions)[] = [
      ScopeNames.WITH_TAGS,
      ScopeNames.WITH_BLACKLISTED,
      ScopeNames.WITH_ACCOUNT_DETAILS,
      ScopeNames.WITH_SCHEDULED_UPDATE,
      ScopeNames.WITH_WEBTORRENT_FILES,
      ScopeNames.WITH_STREAMING_PLAYLISTS,
      ScopeNames.WITH_THUMBNAILS,
      ScopeNames.WITH_LIVE
    ]

    if (userId) {
      scopes.push({ method: [ ScopeNames.WITH_USER_HISTORY, userId ] })
    }

    return VideoModel
      .scope(scopes)
      .findOne(options)
  }

  static loadForGetAPI (parameters: {
    id: number | string
    t?: Transaction
    userId?: number
  }): Promise<MVideoDetails> {
    const { id, t, userId } = parameters
    const where = buildWhereIdOrUUID(id)

    const options = {
      order: [ [ 'Tags', 'name', 'ASC' ] ] as any, // FIXME: sequelize typings
      where,
      transaction: t
    }

    const scopes: (string | ScopeOptions)[] = [
      ScopeNames.WITH_TAGS,
      ScopeNames.WITH_BLACKLISTED,
      ScopeNames.WITH_ACCOUNT_DETAILS,
      ScopeNames.WITH_SCHEDULED_UPDATE,
      ScopeNames.WITH_THUMBNAILS,
      ScopeNames.WITH_LIVE,
      ScopeNames.WITH_TRACKERS,
      { method: [ ScopeNames.WITH_WEBTORRENT_FILES, true ] },
      { method: [ ScopeNames.WITH_STREAMING_PLAYLISTS, true ] }
    ]

    if (userId) {
      scopes.push({ method: [ ScopeNames.WITH_USER_HISTORY, userId ] })
    }

    return VideoModel
      .scope(scopes)
      .findOne(options)
  }

  static async getStats () {
    const totalLocalVideos = await VideoModel.count({
      where: {
        remote: false
      }
    })

    let totalLocalVideoViews = await VideoModel.sum('views', {
      where: {
        remote: false
      }
    })

    // Sequelize could return null...
    if (!totalLocalVideoViews) totalLocalVideoViews = 0

    const { total: totalVideos } = await VideoModel.listForApi({
      start: 0,
      count: 0,
      sort: '-publishedAt',
      nsfw: buildNSFWFilter(),
      includeLocalVideos: true,
      withFiles: false
    })

    return {
      totalLocalVideos,
      totalLocalVideoViews,
      totalVideos
    }
  }

  static incrementViews (id: number, views: number) {
    return VideoModel.increment('views', {
      by: views,
      where: {
        id
      }
    })
  }

  static updateRatesOf (videoId: number, type: VideoRateType, t: Transaction) {
    const field = type === 'like'
      ? 'likes'
      : 'dislikes'

    const rawQuery = `UPDATE "video" SET "${field}" = ` +
      '(' +
      'SELECT COUNT(id) FROM "accountVideoRate" WHERE "accountVideoRate"."videoId" = "video"."id" AND type = :rateType' +
      ') ' +
      'WHERE "video"."id" = :videoId'

    return AccountVideoRateModel.sequelize.query(rawQuery, {
      transaction: t,
      replacements: { videoId, rateType: type },
      type: QueryTypes.UPDATE
    })
  }

  static checkVideoHasInstanceFollow (videoId: number, followerActorId: number) {
    // Instances only share videos
    const query = 'SELECT 1 FROM "videoShare" ' +
      'INNER JOIN "actorFollow" ON "actorFollow"."targetActorId" = "videoShare"."actorId" ' +
      'WHERE "actorFollow"."actorId" = $followerActorId AND "actorFollow"."state" = \'accepted\' AND "videoShare"."videoId" = $videoId ' +
      'LIMIT 1'

    const options = {
      type: QueryTypes.SELECT as QueryTypes.SELECT,
      bind: { followerActorId, videoId },
      raw: true
    }

    return VideoModel.sequelize.query(query, options)
                     .then(results => results.length === 1)
  }

  static bulkUpdateSupportField (videoChannel: MChannel, t: Transaction) {
    const options = {
      where: {
        channelId: videoChannel.id
      },
      transaction: t
    }

    return VideoModel.update({ support: videoChannel.support }, options)
  }

  static getAllIdsFromChannel (videoChannel: MChannelId): Promise<number[]> {
    const query = {
      attributes: [ 'id' ],
      where: {
        channelId: videoChannel.id
      }
    }

    return VideoModel.findAll(query)
                     .then(videos => videos.map(v => v.id))
  }

  // threshold corresponds to how many video the field should have to be returned
  static async getRandomFieldSamples (field: 'category' | 'channelId', threshold: number, count: number) {
    const serverActor = await getServerActor()
    const followerActorId = serverActor.id

    const queryOptions: BuildVideosQueryOptions = {
      attributes: [ `"${field}"` ],
      group: `GROUP BY "${field}"`,
      having: `HAVING COUNT("${field}") >= ${threshold}`,
      start: 0,
      sort: 'random',
      count,
      serverAccountId: serverActor.Account.id,
      followerActorId,
      includeLocalVideos: true
    }

    const { query, replacements } = buildListQuery(VideoModel, queryOptions)

    return this.sequelize.query<any>(query, { replacements, type: QueryTypes.SELECT })
        .then(rows => rows.map(r => r[field]))
  }

  static buildTrendingQuery (trendingDays: number) {
    return {
      attributes: [],
      subQuery: false,
      model: VideoViewModel,
      required: false,
      where: {
        startDate: {
          [Op.gte]: new Date(new Date().getTime() - (24 * 3600 * 1000) * trendingDays)
        }
      }
    }
  }

  private static async getAvailableForApi (
    options: BuildVideosQueryOptions,
    countVideos = true
  ): Promise<ResultList<VideoModel>> {
    function getCount () {
      if (countVideos !== true) return Promise.resolve(undefined)

      const countOptions = Object.assign({}, options, { isCount: true })
      const { query: queryCount, replacements: replacementsCount } = buildListQuery(VideoModel, countOptions)

      return VideoModel.sequelize.query<any>(queryCount, { replacements: replacementsCount, type: QueryTypes.SELECT })
          .then(rows => rows.length !== 0 ? rows[0].total : 0)
    }

    function getModels () {
      if (options.count === 0) return Promise.resolve([])

      const { query, replacements, order } = buildListQuery(VideoModel, options)
      const queryModels = wrapForAPIResults(query, replacements, options, order)

      return VideoModel.sequelize.query<any>(queryModels, { replacements, type: QueryTypes.SELECT, nest: true })
          .then(rows => VideoModel.buildAPIResult(rows))
    }

    const [ count, rows ] = await Promise.all([ getCount(), getModels() ])

    return {
      data: rows,
      total: count
    }
  }

  private static buildAPIResult (rows: any[]) {
    const videosMemo: { [ id: number ]: VideoModel } = {}
    const videoStreamingPlaylistMemo: { [ id: number ]: VideoStreamingPlaylistModel } = {}

    const thumbnailsDone = new Set<number>()
    const historyDone = new Set<number>()
    const videoFilesDone = new Set<number>()

    const videos: VideoModel[] = []

    const avatarKeys = [ 'id', 'filename', 'fileUrl', 'onDisk', 'createdAt', 'updatedAt' ]
    const actorKeys = [ 'id', 'preferredUsername', 'url', 'serverId', 'avatarId' ]
    const serverKeys = [ 'id', 'host' ]
    const videoFileKeys = [
      'id',
      'createdAt',
      'updatedAt',
      'resolution',
      'size',
      'extname',
      'filename',
      'fileUrl',
      'torrentFilename',
      'torrentUrl',
      'infoHash',
      'fps',
      'videoId',
      'videoStreamingPlaylistId'
    ]
    const videoStreamingPlaylistKeys = [ 'id', 'type', 'playlistUrl' ]
    const videoKeys = [
      'id',
      'uuid',
      'name',
      'category',
      'licence',
      'language',
      'privacy',
      'nsfw',
      'description',
      'support',
      'duration',
      'views',
      'likes',
      'dislikes',
      'remote',
      'isLive',
      'url',
      'commentsEnabled',
      'downloadEnabled',
      'waitTranscoding',
      'state',
      'publishedAt',
      'originallyPublishedAt',
      'channelId',
      'createdAt',
      'updatedAt'
    ]
    const buildOpts = { raw: true }

    function buildActor (rowActor: any) {
      const avatarModel = rowActor.Avatar.id !== null
        ? new ActorImageModel(pick(rowActor.Avatar, avatarKeys), buildOpts)
        : null

      const serverModel = rowActor.Server.id !== null
        ? new ServerModel(pick(rowActor.Server, serverKeys), buildOpts)
        : null

      const actorModel = new ActorModel(pick(rowActor, actorKeys), buildOpts)
      actorModel.Avatar = avatarModel
      actorModel.Server = serverModel

      return actorModel
    }

    for (const row of rows) {
      if (!videosMemo[row.id]) {
        // Build Channel
        const channel = row.VideoChannel
        const channelModel = new VideoChannelModel(pick(channel, [ 'id', 'name', 'description', 'actorId' ]), buildOpts)
        channelModel.Actor = buildActor(channel.Actor)

        const account = row.VideoChannel.Account
        const accountModel = new AccountModel(pick(account, [ 'id', 'name' ]), buildOpts)
        accountModel.Actor = buildActor(account.Actor)

        channelModel.Account = accountModel

        const videoModel = new VideoModel(pick(row, videoKeys), buildOpts)
        videoModel.VideoChannel = channelModel

        videoModel.UserVideoHistories = []
        videoModel.Thumbnails = []
        videoModel.VideoFiles = []
        videoModel.VideoStreamingPlaylists = []

        videosMemo[row.id] = videoModel
        // Don't take object value to have a sorted array
        videos.push(videoModel)
      }

      const videoModel = videosMemo[row.id]

      if (row.userVideoHistory?.id && !historyDone.has(row.userVideoHistory.id)) {
        const historyModel = new UserVideoHistoryModel(pick(row.userVideoHistory, [ 'id', 'currentTime' ]), buildOpts)
        videoModel.UserVideoHistories.push(historyModel)

        historyDone.add(row.userVideoHistory.id)
      }

      if (row.Thumbnails?.id && !thumbnailsDone.has(row.Thumbnails.id)) {
        const thumbnailModel = new ThumbnailModel(pick(row.Thumbnails, [ 'id', 'type', 'filename' ]), buildOpts)
        videoModel.Thumbnails.push(thumbnailModel)

        thumbnailsDone.add(row.Thumbnails.id)
      }

      if (row.VideoFiles?.id && !videoFilesDone.has(row.VideoFiles.id)) {
        const videoFileModel = new VideoFileModel(pick(row.VideoFiles, videoFileKeys), buildOpts)
        videoModel.VideoFiles.push(videoFileModel)

        videoFilesDone.add(row.VideoFiles.id)
      }

      if (row.VideoStreamingPlaylists?.id && !videoStreamingPlaylistMemo[row.VideoStreamingPlaylists.id]) {
        const streamingPlaylist = new VideoStreamingPlaylistModel(pick(row.VideoStreamingPlaylists, videoStreamingPlaylistKeys), buildOpts)
        streamingPlaylist.VideoFiles = []

        videoModel.VideoStreamingPlaylists.push(streamingPlaylist)

        videoStreamingPlaylistMemo[streamingPlaylist.id] = streamingPlaylist
      }

      if (row.VideoStreamingPlaylists?.VideoFiles?.id && !videoFilesDone.has(row.VideoStreamingPlaylists.VideoFiles.id)) {
        const streamingPlaylist = videoStreamingPlaylistMemo[row.VideoStreamingPlaylists.id]

        const videoFileModel = new VideoFileModel(pick(row.VideoStreamingPlaylists.VideoFiles, videoFileKeys), buildOpts)
        streamingPlaylist.VideoFiles.push(videoFileModel)

        videoFilesDone.add(row.VideoStreamingPlaylists.VideoFiles.id)
      }
    }

    return videos
  }

  static getCategoryLabel (id: number) {
    return VIDEO_CATEGORIES[id] || 'Misc'
  }

  static getLicenceLabel (id: number) {
    return VIDEO_LICENCES[id] || 'Unknown'
  }

  static getLanguageLabel (id: string) {
    return VIDEO_LANGUAGES[id] || 'Unknown'
  }

  static getPrivacyLabel (id: number) {
    return VIDEO_PRIVACIES[id] || 'Unknown'
  }

  static getStateLabel (id: number) {
    return VIDEO_STATES[id] || 'Unknown'
  }

  isBlacklisted () {
    return !!this.VideoBlacklist
  }

  isBlocked () {
    return this.VideoChannel.Account.Actor.Server?.isBlocked() || this.VideoChannel.Account.isBlocked()
  }

  getQualityFileBy<T extends MVideoWithFile> (this: T, fun: (files: MVideoFile[], it: (file: MVideoFile) => number) => MVideoFile) {
    // We first transcode to WebTorrent format, so try this array first
    if (Array.isArray(this.VideoFiles) && this.VideoFiles.length !== 0) {
      const file = fun(this.VideoFiles, file => file.resolution)

      return Object.assign(file, { Video: this })
    }

    // No webtorrent files, try with streaming playlist files
    if (Array.isArray(this.VideoStreamingPlaylists) && this.VideoStreamingPlaylists.length !== 0) {
      const streamingPlaylistWithVideo = Object.assign(this.VideoStreamingPlaylists[0], { Video: this })

      const file = fun(streamingPlaylistWithVideo.VideoFiles, file => file.resolution)
      return Object.assign(file, { VideoStreamingPlaylist: streamingPlaylistWithVideo })
    }

    return undefined
  }

  getMaxQualityFile<T extends MVideoWithFile> (this: T): MVideoFileVideo | MVideoFileStreamingPlaylistVideo {
    return this.getQualityFileBy(maxBy)
  }

  getMinQualityFile<T extends MVideoWithFile> (this: T): MVideoFileVideo | MVideoFileStreamingPlaylistVideo {
    return this.getQualityFileBy(minBy)
  }

  getWebTorrentFile<T extends MVideoWithFile> (this: T, resolution: number): MVideoFileVideo {
    if (Array.isArray(this.VideoFiles) === false) return undefined

    const file = this.VideoFiles.find(f => f.resolution === resolution)
    if (!file) return undefined

    return Object.assign(file, { Video: this })
  }

  hasWebTorrentFiles () {
    return Array.isArray(this.VideoFiles) === true && this.VideoFiles.length !== 0
  }

  async addAndSaveThumbnail (thumbnail: MThumbnail, transaction: Transaction) {
    thumbnail.videoId = this.id

    const savedThumbnail = await thumbnail.save({ transaction })

    if (Array.isArray(this.Thumbnails) === false) this.Thumbnails = []

    // Already have this thumbnail, skip
    if (this.Thumbnails.find(t => t.id === savedThumbnail.id)) return

    this.Thumbnails.push(savedThumbnail)
  }

  getMiniature () {
    if (Array.isArray(this.Thumbnails) === false) return undefined

    return this.Thumbnails.find(t => t.type === ThumbnailType.MINIATURE)
  }

  hasPreview () {
    return !!this.getPreview()
  }

  getPreview () {
    if (Array.isArray(this.Thumbnails) === false) return undefined

    return this.Thumbnails.find(t => t.type === ThumbnailType.PREVIEW)
  }

  isOwned () {
    return this.remote === false
  }

  getWatchStaticPath () {
    return '/videos/watch/' + this.uuid
  }

  getEmbedStaticPath () {
    return '/videos/embed/' + this.uuid
  }

  getMiniatureStaticPath () {
    const thumbnail = this.getMiniature()
    if (!thumbnail) return null

    return join(STATIC_PATHS.THUMBNAILS, thumbnail.filename)
  }

  getPreviewStaticPath () {
    const preview = this.getPreview()
    if (!preview) return null

    // We use a local cache, so specify our cache endpoint instead of potential remote URL
    return join(LAZY_STATIC_PATHS.PREVIEWS, preview.filename)
  }

  toFormattedJSON (this: MVideoFormattable, options?: VideoFormattingJSONOptions): Video {
    return videoModelToFormattedJSON(this, options)
  }

  toFormattedDetailsJSON (this: MVideoFormattableDetails): VideoDetails {
    return videoModelToFormattedDetailsJSON(this)
  }

  getFormattedVideoFilesJSON (includeMagnet = true): VideoFile[] {
    let files: VideoFile[] = []

    if (Array.isArray(this.VideoFiles)) {
      const result = videoFilesModelToFormattedJSON(this, this.VideoFiles, includeMagnet)
      files = files.concat(result)
    }

    for (const p of (this.VideoStreamingPlaylists || [])) {
      const result = videoFilesModelToFormattedJSON(this, p.VideoFiles, includeMagnet)
      files = files.concat(result)
    }

    return files
  }

  toActivityPubObject (this: MVideoAP): VideoObject {
    return videoModelToActivityPubObject(this)
  }

  getTruncatedDescription () {
    if (!this.description) return null

    const maxLength = CONSTRAINTS_FIELDS.VIDEOS.TRUNCATED_DESCRIPTION.max
    return peertubeTruncate(this.description, { length: maxLength })
  }

  getMaxQualityResolution () {
    const file = this.getMaxQualityFile()
    const videoOrPlaylist = file.getVideoOrStreamingPlaylist()
    const originalFilePath = getVideoFilePath(videoOrPlaylist, file)

    return getVideoFileResolution(originalFilePath)
  }

  getDescriptionAPIPath () {
    return `/api/${API_VERSION}/videos/${this.uuid}/description`
  }

  getHLSPlaylist (): MStreamingPlaylistFilesVideo {
    if (!this.VideoStreamingPlaylists) return undefined

    const playlist = this.VideoStreamingPlaylists.find(p => p.type === VideoStreamingPlaylistType.HLS)
    playlist.Video = this

    return playlist
  }

  setHLSPlaylist (playlist: MStreamingPlaylist) {
    const toAdd = [ playlist ] as [ VideoStreamingPlaylistModel ]

    if (Array.isArray(this.VideoStreamingPlaylists) === false || this.VideoStreamingPlaylists.length === 0) {
      this.VideoStreamingPlaylists = toAdd
      return
    }

    this.VideoStreamingPlaylists = this.VideoStreamingPlaylists
                                       .filter(s => s.type !== VideoStreamingPlaylistType.HLS)
                                       .concat(toAdd)
  }

  removeFile (videoFile: MVideoFile, isRedundancy = false) {
    const filePath = getVideoFilePath(this, videoFile, isRedundancy)
    return remove(filePath)
      .catch(err => logger.warn('Cannot delete file %s.', filePath, { err }))
  }

  async removeStreamingPlaylistFiles (streamingPlaylist: MStreamingPlaylist, isRedundancy = false) {
    const directoryPath = getHLSDirectory(this, isRedundancy)

    await remove(directoryPath)

    if (isRedundancy !== true) {
      const streamingPlaylistWithFiles = streamingPlaylist as MStreamingPlaylistFilesVideo
      streamingPlaylistWithFiles.Video = this

      if (!Array.isArray(streamingPlaylistWithFiles.VideoFiles)) {
        streamingPlaylistWithFiles.VideoFiles = await streamingPlaylistWithFiles.$get('VideoFiles')
      }

      // Remove physical files and torrents
      await Promise.all(
        streamingPlaylistWithFiles.VideoFiles.map(file => file.removeTorrent())
      )
    }
  }

  isOutdated () {
    if (this.isOwned()) return false

    return isOutdated(this, ACTIVITY_PUB.VIDEO_REFRESH_INTERVAL)
  }

  hasPrivacyForFederation () {
    return isPrivacyForFederation(this.privacy)
  }

  hasStateForFederation () {
    return isStateForFederation(this.state)
  }

  isNewVideo (newPrivacy: VideoPrivacy) {
    return this.hasPrivacyForFederation() === false && isPrivacyForFederation(newPrivacy) === true
  }

  setAsRefreshed () {
    this.changed('updatedAt', true)

    return this.save()
  }

  requiresAuth () {
    return this.privacy === VideoPrivacy.PRIVATE || this.privacy === VideoPrivacy.INTERNAL || !!this.VideoBlacklist
  }

  setPrivacy (newPrivacy: VideoPrivacy) {
    if (this.privacy === VideoPrivacy.PRIVATE && newPrivacy !== VideoPrivacy.PRIVATE) {
      this.publishedAt = new Date()
    }

    this.privacy = newPrivacy
  }

  isConfidential () {
    return this.privacy === VideoPrivacy.PRIVATE ||
      this.privacy === VideoPrivacy.UNLISTED ||
      this.privacy === VideoPrivacy.INTERNAL
  }

  async publishIfNeededAndSave (t: Transaction) {
    if (this.state !== VideoState.PUBLISHED) {
      this.state = VideoState.PUBLISHED
      this.publishedAt = new Date()
      await this.save({ transaction: t })

      return true
    }

    return false
  }

  getBandwidthBits (videoFile: MVideoFile) {
    return Math.ceil((videoFile.size * 8) / this.duration)
  }

  getTrackerUrls () {
    if (this.isOwned()) {
      return [
        WEBSERVER.URL + '/tracker/announce',
        WEBSERVER.WS + '://' + WEBSERVER.HOSTNAME + ':' + WEBSERVER.PORT + '/tracker/socket'
      ]
    }

    return this.Trackers.map(t => t.url)
  }
}
