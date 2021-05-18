import * as express from 'express'
import { sanitizeUrl } from '@server/helpers/core-utils'
import { doJSONRequest } from '@server/helpers/requests'
import { CONFIG } from '@server/initializers/config'
import { getOrCreateVideoAndAccountAndChannel } from '@server/lib/activitypub/videos'
import { Hooks } from '@server/lib/plugins/hooks'
import { AccountBlocklistModel } from '@server/models/account/account-blocklist'
import { getServerActor } from '@server/models/application/application'
import { ServerBlocklistModel } from '@server/models/server/server-blocklist'
import { HttpStatusCode } from '@shared/core-utils/miscs/http-error-codes'
import { ResultList, Video, VideoChannel } from '@shared/models'
import { SearchTargetQuery } from '@shared/models/search/search-target-query.model'
import { VideoChannelsSearchQuery, VideosSearchQuery } from '../../../shared/models/search'
import { buildNSFWFilter, isUserAbleToSearchRemoteURI } from '../../helpers/express-utils'
import { logger } from '../../helpers/logger'
import { getFormattedObjects } from '../../helpers/utils'
import { loadActorUrlOrGetFromWebfinger } from '../../helpers/webfinger'
import { getOrCreateActorAndServerAndModel } from '../../lib/activitypub/actor'
import {
  asyncMiddleware,
  commonVideosFiltersValidator,
  optionalAuthenticate,
  paginationValidator,
  setDefaultPagination,
  setDefaultSearchSort,
  videoChannelsListSearchValidator,
  videoChannelsSearchSortValidator,
  videosSearchSortValidator,
  videosSearchValidator
} from '../../middlewares'
import { VideoModel } from '../../models/video/video'
import { VideoChannelModel } from '../../models/video/video-channel'
import { MChannelAccountDefault, MVideoAccountLightBlacklistAllFiles } from '../../types/models'

const searchRouter = express.Router()

searchRouter.get('/videos',
  paginationValidator,
  setDefaultPagination,
  videosSearchSortValidator,
  setDefaultSearchSort,
  optionalAuthenticate,
  commonVideosFiltersValidator,
  videosSearchValidator,
  asyncMiddleware(searchVideos)
)

searchRouter.get('/video-channels',
  paginationValidator,
  setDefaultPagination,
  videoChannelsSearchSortValidator,
  setDefaultSearchSort,
  optionalAuthenticate,
  videoChannelsListSearchValidator,
  asyncMiddleware(searchVideoChannels)
)

// ---------------------------------------------------------------------------

export { searchRouter }

// ---------------------------------------------------------------------------

function searchVideoChannels (req: express.Request, res: express.Response) {
  const query: VideoChannelsSearchQuery = req.query
  const search = query.search

  const isURISearch = search.startsWith('http://') || search.startsWith('https://')

  const parts = search.split('@')

  // Handle strings like @toto@example.com
  if (parts.length === 3 && parts[0].length === 0) parts.shift()
  const isWebfingerSearch = parts.length === 2 && parts.every(p => p && !p.includes(' '))

  if (isURISearch || isWebfingerSearch) return searchVideoChannelURI(search, isWebfingerSearch, res)

  // @username -> username to search in DB
  if (query.search.startsWith('@')) query.search = query.search.replace(/^@/, '')

  if (isSearchIndexSearch(query)) {
    return searchVideoChannelsIndex(query, res)
  }

  return searchVideoChannelsDB(query, res)
}

async function searchVideoChannelsIndex (query: VideoChannelsSearchQuery, res: express.Response) {
  const result = await buildMutedForSearchIndex(res)

  const body = await Hooks.wrapObject(Object.assign(query, result), 'filter:api.search.video-channels.index.list.params')

  const url = sanitizeUrl(CONFIG.SEARCH.SEARCH_INDEX.URL) + '/api/v1/search/video-channels'

  try {
    logger.debug('Doing video channels search index request on %s.', url, { body })

    const { body: searchIndexResult } = await doJSONRequest<ResultList<VideoChannel>>(url, { method: 'POST', json: body })
    const jsonResult = await Hooks.wrapObject(searchIndexResult, 'filter:api.search.video-channels.index.list.result')

    return res.json(jsonResult)
  } catch (err) {
    logger.warn('Cannot use search index to make video channels search.', { err })

    return res.sendStatus(HttpStatusCode.INTERNAL_SERVER_ERROR_500)
  }
}

async function searchVideoChannelsDB (query: VideoChannelsSearchQuery, res: express.Response) {
  const serverActor = await getServerActor()

  const apiOptions = await Hooks.wrapObject({
    actorId: serverActor.id,
    search: query.search,
    start: query.start,
    count: query.count,
    sort: query.sort
  }, 'filter:api.search.video-channels.local.list.params')

  const resultList = await Hooks.wrapPromiseFun(
    VideoChannelModel.searchForApi,
    apiOptions,
    'filter:api.search.video-channels.local.list.result'
  )

  return res.json(getFormattedObjects(resultList.data, resultList.total))
}

async function searchVideoChannelURI (search: string, isWebfingerSearch: boolean, res: express.Response) {
  let videoChannel: MChannelAccountDefault
  let uri = search

  if (isWebfingerSearch) {
    try {
      uri = await loadActorUrlOrGetFromWebfinger(search)
    } catch (err) {
      logger.warn('Cannot load actor URL or get from webfinger.', { search, err })

      return res.json({ total: 0, data: [] })
    }
  }

  if (isUserAbleToSearchRemoteURI(res)) {
    try {
      const actor = await getOrCreateActorAndServerAndModel(uri, 'all', true, true)
      videoChannel = actor.VideoChannel
    } catch (err) {
      logger.info('Cannot search remote video channel %s.', uri, { err })
    }
  } else {
    videoChannel = await VideoChannelModel.loadByUrlAndPopulateAccount(uri)
  }

  return res.json({
    total: videoChannel ? 1 : 0,
    data: videoChannel ? [ videoChannel.toFormattedJSON() ] : []
  })
}

function searchVideos (req: express.Request, res: express.Response) {
  const query: VideosSearchQuery = req.query
  const search = query.search

  if (search && (search.startsWith('http://') || search.startsWith('https://'))) {
    return searchVideoURI(search, res)
  }

  if (isSearchIndexSearch(query)) {
    return searchVideosIndex(query, res)
  }

  return searchVideosDB(query, res)
}

async function searchVideosIndex (query: VideosSearchQuery, res: express.Response) {
  const result = await buildMutedForSearchIndex(res)

  let body: VideosSearchQuery = Object.assign(query, result)

  // Use the default instance NSFW policy if not specified
  if (!body.nsfw) {
    const nsfwPolicy = res.locals.oauth
      ? res.locals.oauth.token.User.nsfwPolicy
      : CONFIG.INSTANCE.DEFAULT_NSFW_POLICY

    body.nsfw = nsfwPolicy === 'do_not_list'
      ? 'false'
      : 'both'
  }

  body = await Hooks.wrapObject(body, 'filter:api.search.videos.index.list.params')

  const url = sanitizeUrl(CONFIG.SEARCH.SEARCH_INDEX.URL) + '/api/v1/search/videos'

  try {
    logger.debug('Doing videos search index request on %s.', url, { body })

    const { body: searchIndexResult } = await doJSONRequest<ResultList<Video>>(url, { method: 'POST', json: body })
    const jsonResult = await Hooks.wrapObject(searchIndexResult, 'filter:api.search.videos.index.list.result')

    return res.json(jsonResult)
  } catch (err) {
    logger.warn('Cannot use search index to make video search.', { err })

    return res.sendStatus(HttpStatusCode.INTERNAL_SERVER_ERROR_500)
  }
}

async function searchVideosDB (query: VideosSearchQuery, res: express.Response) {
  const apiOptions = await Hooks.wrapObject(Object.assign(query, {
    includeLocalVideos: true,
    nsfw: buildNSFWFilter(res, query.nsfw),
    filter: query.filter,
    user: res.locals.oauth ? res.locals.oauth.token.User : undefined
  }), 'filter:api.search.videos.local.list.params')

  const resultList = await Hooks.wrapPromiseFun(
    VideoModel.searchAndPopulateAccountAndServer,
    apiOptions,
    'filter:api.search.videos.local.list.result'
  )

  return res.json(getFormattedObjects(resultList.data, resultList.total))
}

async function searchVideoURI (url: string, res: express.Response) {
  let video: MVideoAccountLightBlacklistAllFiles

  // Check if we can fetch a remote video with the URL
  if (isUserAbleToSearchRemoteURI(res)) {
    try {
      const syncParam = {
        likes: false,
        dislikes: false,
        shares: false,
        comments: false,
        thumbnail: true,
        refreshVideo: false
      }

      const result = await getOrCreateVideoAndAccountAndChannel({ videoObject: url, syncParam })
      video = result ? result.video : undefined
    } catch (err) {
      logger.info('Cannot search remote video %s.', url, { err })
    }
  } else {
    video = await VideoModel.loadByUrlAndPopulateAccount(url)
  }

  return res.json({
    total: video ? 1 : 0,
    data: video ? [ video.toFormattedJSON() ] : []
  })
}

function isSearchIndexSearch (query: SearchTargetQuery) {
  if (query.searchTarget === 'search-index') return true

  const searchIndexConfig = CONFIG.SEARCH.SEARCH_INDEX

  if (searchIndexConfig.ENABLED !== true) return false

  if (searchIndexConfig.DISABLE_LOCAL_SEARCH) return true
  if (searchIndexConfig.IS_DEFAULT_SEARCH && !query.searchTarget) return true

  return false
}

async function buildMutedForSearchIndex (res: express.Response) {
  const serverActor = await getServerActor()
  const accountIds = [ serverActor.Account.id ]

  if (res.locals.oauth) {
    accountIds.push(res.locals.oauth.token.User.Account.id)
  }

  const [ blockedHosts, blockedAccounts ] = await Promise.all([
    ServerBlocklistModel.listHostsBlockedBy(accountIds),
    AccountBlocklistModel.listHandlesBlockedBy(accountIds)
  ])

  return {
    blockedHosts,
    blockedAccounts
  }
}